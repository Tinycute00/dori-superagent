import { afterEach, beforeEach, expect, test } from "bun:test";

import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

// The fake herdr reports shell_pid 100 for every pane (fakes.ts), so 100 is the lane pane's root process.
const lane: Lane = {
  key: "demo-lane",
  title: "demo",
  thread: "none",
  pane: "w:p1",
  brief: "/briefs/demo.md",
  done: "merged acme/app#1",
  cwd: "/repo",
  openedAt: "2026-01-01T11:00:00.000Z",
};

// Before the close: the pane's shell, its agent, one watch pipeline the agent started, and processes of other owners.
const BEFORE = [
  "  1     0 /sbin/init",
  "100     1 -bash",
  "101   100 agent --session demo",
  "200   101 /bin/sh -c tail -n 0 -F /tmp/build.log | grep --line-buffered FAIL",
  "201   200 tail -n 0 -F /tmp/build.log",
  "202   200 grep --line-buffered FAIL",
  "300     1 tail -n 0 -F /tmp/build.log",
  "400     1 agent --session other",
].join("\n");

let state: ReturnType<typeof withState>;
let world: World;
let tables: string[];

const kills = () => world.calls.filter((c) => c[0] === "kill");
const receipt = (lines: readonly string[]) =>
  JSON.parse(lines.at(-1)?.replace(/^CLOSED \S+ /, "") ?? "{}") as { cleanup: string[] };

const deps = (): FlowDeps => {
  const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), state.dir);
  const inner = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "ps") {
      world.calls.push([...argv]);
      const out = tables.shift();
      return out === undefined ? { code: 1, out: "", err: "ps: unavailable" } : { code: 0, out, err: "" };
    }
    if (argv[0] === "kill") {
      world.calls.push([...argv]);
      return { code: 0, out: "", err: "" };
    }
    return inner(argv, opts);
  };
  return { ...base, run };
};

beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
});
afterEach(() => state.done());

test("watchers the lane started that outlive its pane are stopped by exact pid, and nothing else is", async () => {
  // After the pane closed, the watch pipeline was re-parented to init and kept running.
  tables = [
    BEFORE,
    [
      "  1     0 /sbin/init",
      "200     1 /bin/sh -c tail -n 0 -F /tmp/build.log | grep --line-buffered FAIL",
      "201   200 tail -n 0 -F /tmp/build.log",
      "202   200 grep --line-buffered FAIL",
      "300     1 tail -n 0 -F /tmp/build.log",
      "400     1 agent --session other",
    ].join("\n"),
  ];
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([["kill", "-TERM", "200", "201", "202"]]);
  expect(receipt(r.lines).cleanup).toContain("3 lane processes outlived the pane, stopped: 200 201 202");
});

test("a pid reused by another program after the close is left alone", async () => {
  tables = [BEFORE, ["  1     0 /sbin/init", "201     1 /usr/bin/editor notes.md"].join("\n")];
  const r = await closeLane(deps(), lane, "Done");
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("no lane process outlived the pane");
});

test("an unreadable process table stops nothing, says so, and does not hold the close", async () => {
  tables = [];
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(kills()).toEqual([]);
  expect(receipt(r.lines).cleanup).toContain("lane processes not checked: ps: unavailable");
});
