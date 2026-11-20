import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  // NaN means the probe could not read the value: no headroom above the floor rather than a guess.
  const memKnown = Number.isFinite(host.memFreePct),
    loadKnown = Number.isFinite(host.load1);
  const freeGb = (host.memFreePct / 100) * host.memTotalGb;
  const spareGb = freeGb - (p.memFreeMinPct / 100) * host.memTotalGb - warming * p.jobMemGb;
  // The tolerance keeps a job that leaves exactly the floor (an exact 1.0 computed as 0.9999...) admitted.
  const fits = memKnown ? Math.floor(spareGb / p.jobMemGb + 1e-9) : Number.NEGATIVE_INFINITY;
  const loadOk = loadKnown && host.load1 < p.maxLoad;
  const wanted = loadOk ? running + fits : Math.min(running, running + fits);
  const limit = Math.max(p.minSlots, Math.min(p.maxSlots, wanted));
  const bound = wanted >= p.maxSlots ? "ceiling" : wanted < p.minSlots ? "floor" : !loadOk ? "load" : "memory";
  const reason =
    `limit ${limit} of ${p.minSlots}-${p.maxSlots} (${bound}), running ${running}${warming ? ` (${warming} starting)` : ""}: ` +
    (memKnown
      ? `memory ${+host.memFreePct.toFixed(1)}% free (${freeGb.toFixed(1)} of ${host.memTotalGb.toFixed(0)} GB), ` +
        `${p.jobMemGb} GB per job above ${p.memFreeMinPct}% fits ${fits >= 0 ? `${fits} more` : `${-fits} fewer`}; `
      : "memory unknown (could not be read); ") +
    (loadKnown
      ? `load ${host.load1.toFixed(1)} ${loadOk ? "<" : ">="} ${p.maxLoad}`
      : "load unknown (could not be read)");
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

const isMissing = (e: unknown): boolean => (e as { code?: string } | null)?.code === "ENOENT";

// null = no owner file (yet); "unreadable" = it is there but cannot be read, so its holder is unknown.
const readOwner = (slot: string): Owner | null | "unreadable" => {
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch (e) {
    return isMissing(e) ? null : "unreadable";
  }
  const words = owner.trim().split(/\s+/);
  return { pid: Number(words[0]), label: words.slice(1, -1).join(" "), since: Date.parse(words.at(-1) ?? "") };
};

// True only when the slot is confirmed free: its owner is dead, or it has no owner file and is older than ORPHAN_MS, or
// it is gone. Anything that cannot be confirmed keeps the slot held.
const orphaned = (deps: Pick<SlotDeps, "alive" | "clock">, slot: string): boolean => {
  const owner = readOwner(slot);
  if (owner === "unreadable") return false;
  if (owner) return !deps.alive(owner.pid);
  try {
    return deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  } catch (e) {
    return isMissing(e);
  }
};

export type HeldSlot = { readonly slot: string; readonly owner: Owner | null };

const ownerOf = (slot: string): Owner | null => {
  const owner = readOwner(slot);
  return owner === "unreadable" ? null : owner;
};

export const heldSlots = (deps: Pick<SlotDeps, "dir" | "alive" | "clock">): HeldSlot[] => {
  let names: string[] = [];
  try {
    names = readdirSync(deps.dir).filter((n) => /^slot\.\d+$/.test(n));
  } catch (e) {
    if (isMissing(e)) return [];
    throw new HeavyAdmissionError(
      `cannot list heavy slots in ${deps.dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return names
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((n) => join(deps.dir, n))
    .filter((slot) => !orphaned(deps, slot))
    .map((slot) => ({ slot, owner: ownerOf(slot) }));
};

export const warmingCount = (held: readonly HeldSlot[], now: number): number =>
  held.filter((h) => !h.owner || now - h.owner.since < WARMUP_MS).length;

// Only under the admission lock, on a slot heldSlots did not list: either absent or left by a dead owner, so it is
// cleared and claimed without probing its owner again.
const claim = (deps: SlotDeps, slot: string, label: string): string => {
  rmSync(slot, { recursive: true, force: true });
  mkdirSync(slot);
  writeFileSync(join(slot, "owner"), `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`);
  return slot;
};

const LOCK_POLL_MS = 50;
export const SAMPLE_MAX_AGE_MS = 1_000;
const SAMPLE_TRIES = 3;
// Same values in glibc <sys/file.h> and xnu <sys/fcntl.h>.
const LOCK_EX = 2,
  LOCK_NB = 4,
  LOCK_UN = 8;
const LIBC: Readonly<Record<string, string>> = { linux: "libc.so.6", darwin: "/usr/lib/libSystem.B.dylib" };

export type Flock = (fd: number, operation: number) => number;

export class HeavyAdmissionError extends Error {}

// No lock means no heavy admission: a platform or libc without flock(2) stops `dori heavy` with this error instead of
// admitting jobs unguarded.
export const loadFlock = (platform: string = process.platform, path = LIBC[platform]): Flock => {
  if (path === undefined)
    throw new HeavyAdmissionError(`dori heavy needs flock(2); it supports linux (glibc) and macOS, not ${platform}`);
  try {
    const lib = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    return (fd, operation) => lib.symbols.flock(fd, operation);
  } catch (e) {
    throw new HeavyAdmissionError(
      `dori heavy needs flock(2) from ${path} on ${platform} and could not load it: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

let systemFlock: Flock | undefined;
const defaultFlock = (): Flock => (systemFlock ??= loadFlock());

// Sampling the host, counting, deciding and claiming (a takeover included) run under one flock(2) on <dir>/.lock, so
// no two waiters decide on the same count, take the same orphaned slot, or decide on memory sampled before a long wait
// for the lock. The kernel drops the lock only when its holder exits, so a paused holder keeps it and a dead one never
// leaves it behind; no age or pid guess is involved.
export const underLock = async <T>(
  dir: string,
  section: () => T | Promise<T>,
  load: () => Flock = defaultFlock,
): Promise<T> => {
  const flock = load();
  const fd = openSync(join(dir, ".lock"), "a");
  try {
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) await Bun.sleep(LOCK_POLL_MS);
    try {
      return await section();
    } finally {
      flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  mkdirSync(deps.dir, { recursive: true });
  let last = "";
  for (;;) {
    const { d, slot } = await underLock(deps.dir, async () => {
      // Every owner probe (ps) runs before the host sample, so the memory reading is the last outside read before the
      // decision and the claim.
      const held = heldSlots(deps);
      const taken = new Set(held.map((h) => h.slot));
      const free = Array.from({ length: deps.policy.maxSlots }, (_, i) => join(deps.dir, `slot.${i + 1}`)).find(
        (s) => !taken.has(s),
      );
      // The age runs from before the first reading (load) to the claim, so a slow probe inside host() counts too. A
      // sample older than SAMPLE_MAX_AGE_MS is taken again; after SAMPLE_TRIES stale samples the readings count as
      // unknown, which admits the floor only.
      for (let tries = 1; ; tries++) {
        const startedAt = deps.clock.now();
        const host = await deps.host();
        const fresh = (): boolean => deps.clock.now() - startedAt <= SAMPLE_MAX_AGE_MS;
        const stale = tries === SAMPLE_TRIES && !fresh();
        const used = stale ? { ...host, load1: Number.NaN, memFreePct: Number.NaN } : host;
        const d0 = heavyAdmission(deps.policy, used, held.length, warmingCount(held, startedAt));
        const d = stale
          ? { ...d0, reason: `${d0.reason}; host sample took over ${SAMPLE_MAX_AGE_MS} ms ${SAMPLE_TRIES} times` }
          : d0;
        if (!d.admit || free === undefined) return { d, slot: null };
        if (stale || fresh()) return { d, slot: claim(deps, free, label) };
      }
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

// False only for a confirmed death (no such process, or a zombie). A process of another user (EPERM), or a ps that
// fails or prints nothing, keeps the slot held: an unknown holder is counted, never reclaimed.
export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as { code?: string } | null)?.code !== "ESRCH";
  }
  let stat = "";
  try {
    stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
  } catch {
    return true;
  }
  return !stat.startsWith("Z");
};
