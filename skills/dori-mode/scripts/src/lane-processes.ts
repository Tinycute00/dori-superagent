import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { ChosenRuntimes, Runner } from "./run.ts";
import { descendants, PS_ARGV, type Proc, parseProcs } from "./session-id.ts";

/** A string is why the table could not be read. */
type Snapshot = readonly Proc[] | string;

const readTable = async (run: Runner): Promise<Snapshot> => {
  const r = await run(PS_ARGV);
  return r.code === 0 ? parseProcs(r.out) : r.err || `ps exited ${r.code}`;
};

/**
 * The lane pane's root process and every process under it, read while the pane is still open. Watches an agent starts
 * in the background (a `tail -F | grep` pipeline, a background shell) are in this tree until the pane closes; after
 * that they are re-parented to init and nothing else ties them to the lane.
 */
export const laneProcesses = async (rts: ChosenRuntimes, run: Runner, ref: SessionRef): Promise<Snapshot> => {
  const root = await rts
    .for(ref)
    .probe(ref)
    .then(
      (p) => p.rootPid,
      () => undefined,
    );
  if (root === undefined) return "the session reported no root process";
  const table = await readTable(run);
  if (typeof table === "string") return table;
  return [...table.filter((p) => p.pid === root), ...descendants(table, root)];
};

/**
 * After the pane is closed: SIGTERM to each recorded process that is still running with the same command line, by
 * exact pid. A pid that now runs another command was reused and is left alone. Never throws; the result is one receipt line.
 */
export const stopLeftovers = async (run: Runner, before: Snapshot): Promise<string> => {
  if (typeof before === "string") return `lane processes not checked: ${before}`;
  const after = before.length ? await readTable(run) : [];
  if (typeof after === "string") return `lane processes not checked: ${after}`;
  const alive = before.filter((p) => after.some((a) => a.pid === p.pid && a.cmd === p.cmd)).map((p) => String(p.pid));
  if (!alive.length) return "no lane process outlived the pane";
  const r = await run(["kill", "-TERM", ...alive]);
  const what = `${alive.length} lane processes outlived the pane`;
  return r.code === 0
    ? `${what}, stopped: ${alive.join(" ")}`
    : `${what}, stop incomplete (${r.err.slice(0, 120)}): ${alive.join(" ")}`;
};
