// What launch reads on a new lane's screen to tell a failed start from omo's warnings (#202).
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";

// One space between words, as the agent prints them: the unwrapped read puts back a space hc cut at a wrap, and a looser
// gap would match code such as `rateLimit` or a key such as `ratelimiter`. A phrase is a whole word: no letter, digit or
// `_` right before it (`moderate limits` is not `rate limit`) or right after it beyond a plain ending (`quotaUsed` is
// not `quota`; `rate limited`, `quotas` still are).
const STARTUP_FAILURE =
  /(?<![a-z0-9_])(?:Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider)(?:s|es|ed|ing)?(?![a-z0-9_])/i;
// omo warns about a user extension it cannot load (`Warning: Failed to load extension "...": ... Cannot find module ...`)
// and starts anyway (#202). Only the warning's own text is removed, never the rest of its line: a row-wrap join can put a
// real failure on the same line. The path may hold the newline of a row the join missed, and a space cut at a wrap may
// be gone, so every gap between words is optional whitespace. Bun goes on with ` imported from <path>` or ` from '<path>'`;
// that path is the extension's own, so it is part of the warning too (a directory named `quota-meter` is not a failure).
// An unquoted path ends at its first script file name (`.js`, `.mjs`, `.ts`, ...) in its LAST segment, never later: a join
// can glue a real failure right after it (`index.jsNo API key`), and a directory such as `anna.tsai/` or `node.js/` is
// not the file name. It may hold spaces (`/Users/John Doe/...`), not a line break.
const EXTENSION_WARNING =
  /Warning:\s*Failed\s*to\s*load\s*extension\s*"[^"]*":\s*(?:Failed\s*to\s*load\s*extension:\s*)?Cannot\s*find\s*module\s*'[^']*'(?:\s*(?:imported\s*)?from\s*(?:'[^']*'|"[^"]*"|[^\n'"]*?\.[cm]?[jt]sx?(?![\w.-]*\/)))?/g;
// A real warning names the extension's full path, so a narrow pane wraps it and `Cannot find module` lands on a later
// row. The startup checks therefore read the screen unwrapped: one line per line the agent printed.
export const startupScreen = (rts: Runtimes, ref: SessionRef): Promise<string> =>
  rts.for(ref).read(ref, 40, { unwrapped: true });
export const startupFailure = (screen: string): string | null =>
  STARTUP_FAILURE.exec(screen.replace(EXTENSION_WARNING, ""))?.[0] ?? null;
