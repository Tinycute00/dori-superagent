// What launch reads on a new lane's screen to tell a failed start from omo's warnings (#202).
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";

/**
 * Every phrase that means a lane failed to start, one row each (#202). `anywhere` rows are text no healthy screen prints,
 * so they match even glued onto the end of a pane-wide line by the unwrapped read (`...okNo API key`). `word` rows are
 * also ordinary words or code, so each must stand alone (see `standsAlone`) and names a failure, not a topic: bare
 * `quota` or `rate limit` is no row, `quota exceeded` and `rate limit reached` are. A gap is one space as printed (the
 * unwrapped read puts back a space hc cut at a wrap), or `_`/`-` in a code, or nothing in a camelCase code.
 * The fixture corpus in test/startup-screen.test.ts holds real error lines and the code and prose each row must not match.
 */
type Boundary = "anywhere" | "word";
const PHRASES: readonly (readonly [Boundary, string])[] = [
  ["anywhere", "Cannot find module"],
  ["anywhere", "All fallback models failed"],
  ["anywhere", "No API key"],
  ["anywhere", "model_not_available"],
  ["anywhere", "Session crashed"],
  ["anywhere", "unknown provider"],
  ["anywhere", "insufficient_quota"],
  ["anywhere", "RESOURCE_EXHAUSTED"],
  ["anywhere", "Too Many Requests"],
  ["anywhere", "rate_limit_error"],
  ["word", "rate[ _-]?limit(?:s)?[ _-]?(?:exceeded|reached|hit|error)"],
  ["word", "rate[ -]limit(?:ed|er)"],
  ["word", "usage[ _-]?limit(?:s)?[ _-]?(?:exceeded|reached|hit)"],
  ["word", "quota(?:s)?[ _-]?(?:exceeded|exhausted|reached|hit)"],
  ["word", "exceeded your (?:current )?quota"],
];
const PATTERNS = PHRASES.map(([boundary, source]) => ({ boundary, re: new RegExp(source, "gi") }));
/**
 * A `word` match stands alone when no letter, digit or `_` touches its end, and none its start, except when a join glued
 * it onto a pane-wide line: then it must read as printed text, not an identifier. That is a phrase with a gap
 * (`Rate limit exceeded`, `QUOTA_EXCEEDED`) that starts with a capital or has a `_`, which camelCase (`isQuotaExceeded`,
 * `onRateLimitExceeded`) never is.
 */
const standsAlone = (text: string, at: number, found: string): boolean => {
  if (/[a-z0-9_]/i.test(text[at + found.length] ?? "")) return false;
  if (!/[a-z0-9_]/i.test(text[at - 1] ?? "")) return true;
  return /[ _-]/.test(found) && (/^[A-Z]/.test(found) || found.includes("_"));
};
const firstFailure = (text: string): string | null => {
  let first: { at: number; found: string } | undefined;
  for (const { boundary, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (boundary === "word" && !standsAlone(text, m.index, m[0])) continue;
      if (!first || m.index < first.at) first = { at: m.index, found: m[0] };
      break;
    }
  }
  return first?.found ?? null;
};
// omo warns about a user extension it cannot load (`Warning: Failed to load extension "...": ... Cannot find module ...`)
// and starts anyway (#202). Only the warning's own text is removed, never the rest of its line: a row-wrap join can put a
// real failure on the same line. The path may hold the newline of a row the join missed, and a space cut at a wrap may
// be gone, so every gap between words is optional whitespace. Bun goes on with ` imported from <path>` or ` from '<path>'`;
// that path is the extension's own, so it is part of the warning too (a directory named `quota-meter` is not a failure).
// An unquoted path ends at its first script file name (`.js`, `.mjs`, `.ts`, ...) in its LAST segment, never later: a join
// can glue a real failure right after it (`index.jsNo API key`), and a directory such as `anna.tsai/` or `node.js\\` (either
// separator: Bun prints Windows paths with backslashes) is not the file name. It may hold spaces (`/Users/John Doe/...`), not a line break.
const EXTENSION_WARNING =
  /Warning:\s*Failed\s*to\s*load\s*extension\s*"[^"]*":\s*(?:Failed\s*to\s*load\s*extension:\s*)?Cannot\s*find\s*module\s*'[^']*'(?:\s*(?:imported\s*)?from\s*(?:'[^']*'|"[^"]*"|[^\n'"]*?\.[cm]?[jt]sx?(?![\w.-]*[\\/])))?/g;
// A real warning names the extension's full path, so a narrow pane wraps it and `Cannot find module` lands on a later
// row. The startup checks therefore read the screen unwrapped: one line per line the agent printed.
export const startupScreen = (rts: Runtimes, ref: SessionRef): Promise<string> =>
  rts.for(ref).read(ref, 40, { unwrapped: true });
export const startupFailure = (screen: string): string | null => {
  return firstFailure(screen.replace(EXTENSION_WARNING, ""));
};
