import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireSlot,
  type HeavyPolicy,
  heavyAdmission,
  HeavyLockError,
  heldSlots,
  loadFlock,
  underLock,
  WARMUP_MS,
  warmingCount,
} from "../src/heavy-slot.ts";
import { fakeClock, withState } from "./fakes.ts";

const policy: HeavyPolicy = { minSlots: 1, maxSlots: 4, maxLoad: 10, jobMemGb: 4, memFreeMinPct: 15 };
const host = (memFreePct: number, load1 = 2) => ({ load1, memFreePct, memTotalGb: 30 });

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("free memory above the guard floor sets the limit: 15 GB free on 30 GB fits two more 4 GB jobs", () => {
  const d = heavyAdmission(policy, host(50), 1, 0);
  expect(d).toMatchObject({ limit: 3, admit: true });
  expect(d.reason).toStartWith("limit 3 of 1-4 (memory), running 1:");
});

test("the limit never passes the ceiling, however much memory is free", () => {
  expect(heavyAdmission(policy, host(95), 0, 0)).toMatchObject({ limit: 4, admit: true });
  expect(heavyAdmission(policy, host(95), 4, 0)).toMatchObject({ limit: 4, admit: false });
});

test("the floor always runs, even below the memory floor or over the load limit", () => {
  expect(heavyAdmission(policy, host(10), 0, 0)).toMatchObject({ limit: 1, admit: true });
  const loaded = heavyAdmission(policy, host(80, 40), 0, 0);
  expect(loaded).toMatchObject({ limit: 1, admit: true });
  expect(loaded.reason).toStartWith("limit 1 of 1-4 (floor)");
});

test("high load stops admissions above the floor without lowering what already runs", () => {
  const d = heavyAdmission(policy, host(80, 12), 2, 0);
  expect(d).toMatchObject({ limit: 2, admit: false });
  expect(d.reason).toContain("(load)");
  expect(d.reason).toContain("load 12.0 >= 10");
});

test("when memory drops the limit shrinks below the running count and only new admissions stop", () => {
  const d = heavyAdmission(policy, host(12), 3, 0);
  expect(d).toMatchObject({ limit: 2, admit: false });
  expect(d.reason).toContain("fits 1 fewer");
});

test("a job still starting is reserved at the per-job estimate, since free memory does not show it yet", () => {
  expect(heavyAdmission(policy, host(50), 1, 0).limit).toBe(3);
  expect(heavyAdmission(policy, host(50), 1, 1).limit).toBe(2);
});

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

test("a shrunk limit leaves every running slot in place while a new job waits", async () => {
  const dir = join(state.dir, "heavy");
  const T0 = Date.parse("2026-01-01T12:00:00.000Z");
  const since = new Date(T0 - 2 * WARMUP_MS).toISOString();
  for (const n of [1, 2, 3]) {
    mkdirSync(join(dir, `slot.${n}`), { recursive: true });
    writeFileSync(join(dir, `slot.${n}`, "owner"), `${100 + n} job${n} ${since}\n`);
  }
  const logs: string[] = [];
  let polls = 0;
  const clock = {
    ...fakeClock(T0),
    sleep: async () => {
      polls++;
      if (polls > 1) throw new Error("stop");
    },
  };
  const deps = { dir, policy, clock, pid: 7, alive: () => true, log: (l: string) => logs.push(l) };
  await expect(acquireSlot({ ...deps, host: async () => host(12) }, "new", 1)).rejects.toThrow("stop");
  expect(heldSlots(deps).map((h) => h.owner?.label)).toEqual(["job1", "job2", "job3"]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toStartWith("HEAVY_WAIT new limit 2 of 1-4 (memory), running 3:");
});

test("a job that leaves exactly the floor is admitted (the gate's 16780160 kB / 6711328 kB sample)", () => {
  const total = 16780160 / 1024 ** 2;
  const d = heavyAdmission(
    { ...policy, minSlots: 0 },
    { load1: 2, memFreePct: (6711328 / 16780160) * 100, memTotalGb: total },
    1,
    0,
  );
  expect(d).toMatchObject({ limit: 2, admit: true });
});

test("a job that leaves memory just under the floor is held: 27.6% of 31 GB minus 4 GB is 14.7%", () => {
  const p = { ...policy, minSlots: 0 };
  expect(heavyAdmission(p, { load1: 2, memFreePct: 27.6, memTotalGb: 31 }, 1, 0)).toMatchObject({
    limit: 1,
    admit: false,
  });
  expect(heavyAdmission(p, { load1: 2, memFreePct: 28, memTotalGb: 31 }, 1, 0)).toMatchObject({
    limit: 2,
    admit: true,
  });
});

test("a label with spaces keeps its start time, so an old job no longer counts as starting", () => {
  const dir = join(state.dir, "heavy");
  const T0 = Date.parse("2026-01-01T12:00:00.000Z");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), `42 browser suite ${new Date(T0 - 10 * 60_000).toISOString()}`);
  const held = heldSlots({ dir, alive: () => true, clock: fakeClock(T0) });
  expect(held[0]?.owner).toEqual({ pid: 42, label: "browser suite", since: T0 - 10 * 60_000 });
  expect(warmingCount(held, T0)).toBe(0);
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
