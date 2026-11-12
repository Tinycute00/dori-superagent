import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { launchLane } from "../src/launch.ts";
import {
  laneTokenEnv,
  OUTSIDE_HOME_FLAG,
  slackToken,
  TokenFileError,
  tokenFileNotice,
  WIN32_ACL_NOTICE,
} from "../src/slack-token.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const KEYS = ["DORI_CONFIG", "DORI_SLACK_TOKEN", "DORI_SLACK_TOKEN_FILE"] as const;
let state: ReturnType<typeof withState>;
let world: World;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  state = withState();
  world = newWorld();
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  state.done();
});

const tokenFile = (dir: string, text: string, mode: number): string => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slack-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

const launchArgv = async (home: string, key: string): Promise<string[][]> => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  process.env["DORI_CONFIG"] = join(home, "config.json");
  world = newWorld();
  await launchLane(depsFor(world, fakeClock(T0), join(home, "state"), { runtime: "hc" }), {
    key,
    title: "t",
    brief,
    done: "closed acme/app#3",
  });
  return world.calls.map((c) => [...c]);
};

test("the create argv for a lane never contains the token value, only the token file's path (#200)", async () => {
  // Given a launcher with a token in its env and this home's owner-only token file next to its config.
  const home = join(state.dir, "home");
  const file = tokenFile(home, "xoxb-file-secret\n", 0o600);
  process.env["DORI_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  // When the lane is created on hc, which puts every env value on the command line.
  const calls = await launchArgv(home, "token-lane");
  // Then no argv of any call holds a token, and the lane gets the path with DORI_SLACK_TOKEN blanked.
  expect(calls.flat().filter((arg) => arg.includes("xoxb-"))).toEqual([]);
  const create = calls.find((c) => c[0] === "hc" && c.includes("run") && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${file}`);
  expect(create).toContain("DORI_SLACK_TOKEN=");
});

test("with no token file the lane env is unchanged, as in a single-home setup", async () => {
  process.env["DORI_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const calls = await launchArgv(join(state.dir, "plain-home"), "plain-lane");
  expect(calls.flat().filter((arg) => arg.includes("DORI_SLACK_TOKEN") || arg.includes("xoxb-"))).toEqual([]);
});

test("DORI_SLACK_TOKEN is read first, then the token file when the variable is unset or empty", () => {
  const file = tokenFile(join(state.dir, "t"), "  xoxb-from-file\n", 0o600);
  expect(slackToken({ DORI_SLACK_TOKEN: "xoxb-from-env", DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-env");
  expect(slackToken({ DORI_SLACK_TOKEN: "", DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-file");
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-file");
  expect(slackToken({})).toBeUndefined();
});

test("a token file open to group or others is refused on POSIX; Windows has no mode bits to check", () => {
  const file = tokenFile(join(state.dir, "open"), "xoxb-open\n", 0o644);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux")).toThrow(/is open to group or others.*chmod 600/);
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "win32")).toBe("xoxb-open");
});

test("a missing or empty token file is refused, never read as no token", () => {
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: join(state.dir, "absent") })).toThrow(TokenFileError);
  const empty = tokenFile(join(state.dir, "empty"), "\n", 0o600);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: empty })).toThrow(/is empty/);
});

test("a relative token-file path is passed absolute, since the lane runs in another directory", async () => {
  const home = join(state.dir, "rel-home");
  const file = tokenFile(home, "xoxb-rel\n", 0o600);
  process.env["DORI_SLACK_TOKEN_FILE"] = relative(process.cwd(), file);
  const create = (await launchArgv(home, "rel-lane")).find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${file}`);
});

test("a token file the launcher names is passed even when missing, so the lane never falls back to the core's token", async () => {
  const absent = join(state.dir, "named-home", "named", "slack-token");
  process.env["DORI_SLACK_TOKEN_FILE"] = absent;
  const create =
    (await launchArgv(join(state.dir, "named-home"), "named-lane")).find((c) => c[0] === "hc" && c.includes("--bg")) ??
    [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${absent}`);
  expect(create).toContain("DORI_SLACK_TOKEN=");
});

test("a directory or a FIFO at the path is refused as not a regular file, and a FIFO never blocks the read", () => {
  const dir = join(state.dir, "a-dir");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: dir }, "linux")).toThrow(
    `DORI_SLACK_TOKEN_FILE ${dir} is not a regular file`,
  );
  const fifo = join(state.dir, "fifo");
  expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0);
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: fifo }, "linux")).toThrow(
    `DORI_SLACK_TOKEN_FILE ${fifo} is not a regular file`,
  );
});

test("the file is checked and read through one descriptor: a file swapped in after the check is never read", () => {
  const dir = join(state.dir, "swap");
  const file = tokenFile(dir, "xoxb-own\n", 0o600);
  const planted = join(dir, "planted");
  writeFileSync(planted, "xoxb-planted\n");
  chmodSync(planted, 0o600);
  // The path is replaced right after the owner/mode check, the window a stat-then-read-by-path would expose.
  const realFstat = fs.fstatSync;
  const swap = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const st = realFstat(fd);
    renameSync(planted, file);
    return st;
  }) as typeof fs.fstatSync);
  try {
    expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux", process.getuid?.())).toBe("xoxb-own");
    expect(swap).toHaveBeenCalledTimes(1);
  } finally {
    swap.mockRestore();
  }
});

test("a token file owned by another user is refused, even owner-only", () => {
  const file = tokenFile(join(state.dir, "other"), "xoxb-other\n", 0o600);
  const me = process.getuid?.() ?? 0;
  expect(() => slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux", me + 1)).toThrow(
    /is owned by uid \d+, not by this user/,
  );
  expect(slackToken({ DORI_SLACK_TOKEN_FILE: file }, "linux", me)).toBe("xoxb-other");
});

test("an inherited DORI_SLACK_TOKEN_FILE outside this home is refused unless the flag says it is meant", () => {
  const home = join(state.dir, "own-home");
  const config = join(home, "config.json");
  tokenFile(home, "xoxb-own\n", 0o600);
  const other = tokenFile(join(state.dir, "other-home"), "xoxb-other\n", 0o600);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, config)).toThrow(TokenFileError);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, config)).toThrow(/is outside this home/);
  // Allowed by the flag, and the flag is passed empty so the lane does not carry the permission onward.
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other, [OUTSIDE_HOME_FLAG]: "1" }, config)).toEqual({
    DORI_SLACK_TOKEN_FILE: other,
    DORI_SLACK_TOKEN: "",
    [OUTSIDE_HOME_FLAG]: "",
  });
  // Unset, the home's own file is used; a file inside the home is passed as named.
  const ok = (file: string) => ({ DORI_SLACK_TOKEN_FILE: file, DORI_SLACK_TOKEN: "", [OUTSIDE_HOME_FLAG]: "" });
  expect(laneTokenEnv({}, config)).toEqual(ok(join(home, "slack-token")));
  const nested = join(home, "keys", "slack-token");
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: nested }, config)).toEqual(ok(nested));
  // A file whose name starts with ".." is still inside the home.
  const dotted = join(home, "..slack-token");
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: dotted }, config)).toEqual(ok(dotted));
  // A link inside the home to another home's file is outside: links are resolved before the check.
  const link = join(home, "linked-token");
  symlinkSync(other, link);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: link }, config)).toThrow(/is outside this home/);
});

test("the home's own slack-token gets the same link check, and an inherited allow flag never reaches a lane", () => {
  const other = tokenFile(join(state.dir, "far-home"), "xoxb-far\n", 0o600);
  const linked = join(state.dir, "linked-home");
  mkdirSync(linked, { recursive: true });
  symlinkSync(other, join(linked, "slack-token"));
  expect(() => laneTokenEnv({}, join(linked, "config.json"))).toThrow(/links outside this home/);
  // With no token file at all, nothing is added except emptying an inherited allow flag.
  const bare = join(state.dir, "bare-home", "config.json");
  expect(laneTokenEnv({}, bare)).toEqual({});
  expect(laneTokenEnv({ [OUTSIDE_HOME_FLAG]: "1" }, bare)).toEqual({ [OUTSIDE_HOME_FLAG]: "" });
});

test("on Windows a token taken from a file comes with a notice that its ACL is not checked", () => {
  expect(tokenFileNotice({ DORI_SLACK_TOKEN_FILE: "C:\\x\\slack-token" }, "win32")).toBe(WIN32_ACL_NOTICE);
  expect(tokenFileNotice({ DORI_SLACK_TOKEN_FILE: "/x/slack-token" }, "linux")).toBeUndefined();
  expect(tokenFileNotice({ DORI_SLACK_TOKEN: "xoxb-env", DORI_SLACK_TOKEN_FILE: "C:\\x" }, "win32")).toBeUndefined();
});

test("a launch with a token file outside this home is refused before any session is created", async () => {
  const home = join(state.dir, "launch-home");
  const other = tokenFile(join(state.dir, "launch-other"), "xoxb-other\n", 0o600);
  delete process.env["DORI_SLACK_TOKEN"];
  process.env["DORI_SLACK_TOKEN_FILE"] = other;
  delete process.env[OUTSIDE_HOME_FLAG];
  await expect(launchArgv(home, "outside-lane")).rejects.toThrow(
    /^token file refused: DORI_SLACK_TOKEN_FILE .* is outside this home/,
  );
  expect(world.calls.some((c) => c[0] === "hc" && c.includes("run"))).toBe(false);
});
