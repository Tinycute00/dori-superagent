import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "./run.ts";

export type HeavyPolicy = {
  readonly minSlots: number;
  readonly maxSlots: number;
  readonly maxLoad: number;
  readonly jobMemGb: number;
  /** Free memory, in percent of total, that must remain after reserving a new job (the HOST_GUARD threshold). */
  readonly memFreeMinPct: number;
};

export type HeavyHost = { readonly load1: number; readonly memFreePct: number; readonly memTotalGb: number };

export type HeavyDecision = { readonly limit: number; readonly admit: boolean; readonly reason: string };

/**
 * The dynamic slot count. Free memory already excludes what running jobs use, except jobs still starting
 * (`warming`), which are reserved at the per-job estimate. A lower limit than `running` only stops new admissions:
 * nothing here ever ends a running job.
 */
export const heavyAdmission = (p: HeavyPolicy, host: HeavyHost, running: number, warming: number): HeavyDecision => {
  const freeGb = (host.memFreePct / 100) * host.memTotalGb;
  const spareGb = freeGb - (p.memFreeMinPct / 100) * host.memTotalGb - warming * p.jobMemGb;
  const fits = Math.floor(spareGb / p.jobMemGb);
  const loadOk = host.load1 < p.maxLoad;
  const wanted = loadOk ? running + fits : Math.min(running, running + fits);
  const limit = Math.max(p.minSlots, Math.min(p.maxSlots, wanted));
  const bound = wanted >= p.maxSlots ? "ceiling" : wanted < p.minSlots ? "floor" : !loadOk ? "load" : "memory";
  const reason =
    `limit ${limit} of ${p.minSlots}-${p.maxSlots} (${bound}), running ${running}${warming ? ` (${warming} starting)` : ""}: ` +
    `memory ${+host.memFreePct.toFixed(1)}% free (${freeGb.toFixed(1)} of ${host.memTotalGb.toFixed(0)} GB), ` +
    `${p.jobMemGb} GB per job above ${p.memFreeMinPct}% fits ${fits >= 0 ? `${fits} more` : `${-fits} fewer`}; ` +
    `load ${host.load1.toFixed(1)} ${loadOk ? "<" : ">="} ${p.maxLoad}`;
  return { limit, admit: running < limit, reason };
};

export type SlotDeps = {
  readonly dir: string;
  readonly policy: HeavyPolicy;
  readonly clock: Clock;
  readonly host: () => Promise<HeavyHost>;
  readonly alive: (pid: number) => boolean;
  readonly pid: number;
  readonly log: (line: string) => void;
};

const ORPHAN_MS = 60_000;
/** A job this young has not reached its memory yet, so free memory does not show it. */
export const WARMUP_MS = 120_000;

type Owner = { readonly pid: number; readonly label: string; readonly since: number };

const readOwner = (slot: string): Owner | null => {
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch {
    return null;
  }
  const words = owner.trim().split(/\s+/);
  return { pid: Number(words[0]), label: words.slice(1, -1).join(" "), since: Date.parse(words.at(-1) ?? "") };
};

const orphaned = (deps: Pick<SlotDeps, "alive" | "clock">, slot: string): boolean => {
  const owner = readOwner(slot);
  if (owner) return !deps.alive(owner.pid);
  try {
    return deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  } catch {
    return true;
  }
};

export type HeldSlot = { readonly slot: string; readonly owner: Owner | null };

export const heldSlots = (deps: Pick<SlotDeps, "dir" | "alive" | "clock">): HeldSlot[] => {
  let names: string[] = [];
  try {
    names = readdirSync(deps.dir).filter((n) => /^slot\.\d+$/.test(n));
  } catch {
    return [];
  }
  return names
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((n) => join(deps.dir, n))
    .filter((slot) => !orphaned(deps, slot))
    .map((slot) => ({ slot, owner: readOwner(slot) }));
};

export const warmingCount = (held: readonly HeldSlot[], now: number): number =>
  held.filter((h) => !h.owner || now - h.owner.since < WARMUP_MS).length;

const tryTake = (deps: SlotDeps, n: number, label: string): string | null => {
  const slot = join(deps.dir, `slot.${n}`);
  const claim = (): string | null => {
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    writeFileSync(join(slot, "owner"), `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`);
    return slot;
  };
  const got = claim();
  if (got) return got;
  if (!orphaned(deps, slot)) return null;
  rmSync(slot, { recursive: true, force: true });
  return claim();
};

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;

// Counting, deciding and claiming (a takeover included) run under one lock, so no two waiters decide on the same
// count or take the same orphaned slot. The section never awaits; a lock left by a crashed process goes stale.
const underLock = async <T>(deps: SlotDeps, section: () => T): Promise<T> => {
  const lock = join(deps.dir, ".lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else await Bun.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return section();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  mkdirSync(deps.dir, { recursive: true });
  let last = "";
  for (;;) {
    const host = await deps.host();
    const { d, slot } = await underLock(deps, () => {
      const held = heldSlots(deps);
      const d = heavyAdmission(deps.policy, host, held.length, warmingCount(held, deps.clock.now()));
      if (!d.admit) return { d, slot: null };
      for (let n = 1; n <= deps.policy.maxSlots; n++) {
        const slot = tryTake(deps, n, label);
        if (slot) return { d, slot };
      }
      return { d, slot: null };
    });
    if (slot) {
      deps.log(`HEAVY_START ${label} ${d.reason}`);
      return slot;
    }
    if (d.reason !== last) deps.log(`HEAVY_WAIT ${label} ${d.reason}`);
    last = d.reason;
    await deps.clock.sleep(pollMs);
  }
};

export const releaseSlot = (slot: string): void => rmSync(slot, { recursive: true, force: true });

export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return stat !== "" && !stat.startsWith("Z");
};
