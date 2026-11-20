import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireSlot,
  type HeavyPolicy,
  HeavyLockError,
  heldSlots,
  loadFlock,
  underLock,
  WARMUP_MS,
} from "../src/heavy-slot.ts";
import { fakeClock, withState } from "./fakes.ts";

const policy: HeavyPolicy = { minSlots: 1, maxSlots: 4, maxLoad: 10, jobMemGb: 4, memFreeMinPct: 15 };
const host = (memFreePct: number, load1 = 2) => ({ load1, memFreePct, memTotalGb: 30 });

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("waiters that pass the check together cannot take more slots than the limit", async () => {
  const dir = join(state.dir, "heavy");
  const clock = {
    ...fakeClock(Date.parse("2026-01-01T12:00:00.000Z")),
    sleep: async () => {
      throw new Error("stop");
    },
  };
  const deps = { dir, policy, clock, alive: () => true, log: () => {}, host: async () => host(10) };
  const results = await Promise.allSettled([1, 2, 3].map((pid) => acquireSlot({ ...deps, pid }, `w${pid}`, 1)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(heldSlots(deps)).toHaveLength(1);
});

test("the admission lock excludes a second holder until the first section ends", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  let innerRan = false;
  let inner: Promise<void> = Promise.resolve();
  await underLock(dir, () => {
    inner = underLock(dir, () => {
      innerRan = true;
    });
    expect(innerRan).toBe(false);
  });
  await inner;
  expect(innerRan).toBe(true);
});

test("a lock holder that is killed releases the lock, with no age or pid guess", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  const holder = Bun.spawn(
    [
      "bun",
      "-e",
      `const { underLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/heavy-slot.ts"))}); await underLock(${JSON.stringify(dir)}, () => { console.log("LOCKED"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  let seen = "";
  while (!seen.includes("LOCKED")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited before locking: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  holder.kill(9);
  await holder.exited;
  expect(await underLock(dir, () => "free")).toBe("free");
});

test("a platform without a known libc is refused by name, never run without the lock", () => {
  expect(() => loadFlock("plan9")).toThrow(HeavyLockError);
  expect(() => loadFlock("plan9")).toThrow("supports linux (glibc) and macOS, not plan9");
});

test("a libc that cannot be loaded is refused with its path, never run without the lock", () => {
  expect(() => loadFlock("linux", "/nonexistent/libc.so.6")).toThrow(HeavyLockError);
  expect(() => loadFlock("linux", "/nonexistent/libc.so.6")).toThrow(
    "dori heavy needs flock(2) from /nonexistent/libc.so.6 on linux and could not load it",
  );
});

test("when flock cannot be loaded the admission section never runs and nothing is claimed", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  let ran = false;
  await expect(
    underLock(
      dir,
      () => {
        ran = true;
      },
      () => loadFlock("linux", "/nonexistent/libc.so.6"),
    ),
  ).rejects.toThrow(HeavyLockError);
  expect(ran).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(join(dir, ".lock"))).toBe(false);
});

test("a waiter held behind the lock decides on memory sampled after the wait, not before it", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), `101 running ${new Date(Date.now() - 2 * WARMUP_MS).toISOString()}`);
  let free = 80;
  const clock = {
    ...fakeClock(Date.now()),
    sleep: async () => {
      throw new Error("waits");
    },
  };
  const deps = {
    dir,
    policy,
    clock,
    pid: 7,
    alive: () => true,
    log: () => {},
    host: async () => host(free),
  };
  let waiter: Promise<string> = Promise.resolve("");
  await underLock(dir, () => {
    waiter = acquireSlot(deps, "behind-the-lock", 1);
    free = 10;
  });
  await expect(waiter).rejects.toThrow("waits");
  expect(heldSlots(deps)).toHaveLength(1);
});

test("every owner probe runs before the host sample, and a dead owner's slot is still taken", async () => {
  const dir = join(state.dir, "heavy");
  const since = new Date(Date.now() - 2 * WARMUP_MS).toISOString();
  for (const [n, pid] of [
    [1, 101],
    [2, 202],
  ] as const) {
    mkdirSync(join(dir, `slot.${n}`), { recursive: true });
    writeFileSync(join(dir, `slot.${n}`, "owner"), `${pid} job${n} ${since}`);
  }
  const events: string[] = [];
  const slot = await acquireSlot(
    {
      dir,
      policy,
      clock: fakeClock(Date.now()),
      pid: 7,
      log: () => {},
      alive: (pid) => {
        events.push("alive");
        return pid === 101;
      },
      host: async () => {
        events.push("host");
        return host(80);
      },
    },
    "after-probes",
    1,
  );
  expect(events.at(-1)).toBe("host");
  expect(events.filter((e) => e === "host")).toHaveLength(1);
  expect(slot).toBe(join(dir, "slot.2"));
});
