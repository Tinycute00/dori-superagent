import { expect, test } from "bun:test";
import { startupFailure } from "../src/startup-screen.ts";

// Which text on a new lane's screen is a failed start (#202). The hc join itself is tested through launch.
const warning = `Warning: Failed to load extension "/x/ext/index.js": Cannot find module '/x/ext/node_modules/gone/index.mjs'`;

test("omo's extension warning and its Bun tail are not a failure, whatever the path looks like", () => {
  for (const path of [
    "/Users/John Doe/.omo/agent/extensions/quota-meter/index.js",
    "/Users/anna.tsai/.omo/agent/extensions/quota-meter/index.js",
    "/opt/node.js/.omo/agent/extensions/quota-meter/index.js",
    "C:\\Users\\anna.tsai\\.omo\\agent\\extensions\\quota-meter\\index.js",
  ])
    expect(startupFailure(`${warning} imported from ${path}\n❯ `)).toBeNull();
});

// The fixture corpus: real error lines (each with the phrase it must report) and code or prose that must report nothing.
// A new failure phrase or a new false alarm is added here first, then to the table in startup-screen.ts.
const FAILURES: readonly (readonly [string, string])[] = [
  ["Error: Cannot find module '/repo/dist/cli.js'", "Cannot find module"],
  ["All fallback models failed: anthropic, openai", "All fallback models failed"],
  ["No API key found for provider anthropic", "No API key"],
  ["error: model_not_available", "model_not_available"],
  ["Session crashed (exit 1)", "Session crashed"],
  ["Error: unknown provider: foo", "unknown provider"],
  ["error: insufficient_quota", "insufficient_quota"],
  ["Error: 429 Too Many Requests", "Too Many Requests"],
  ["RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GenerateContent requests per minute'", "RESOURCE_EXHAUSTED"],
  ['{"type":"error","error":{"type":"rate_limit_error","message":"request tokens exceeded"}}', "rate_limit_error"],
  [
    "Error: 429 You exceeded your current quota, please check your plan and billing details.",
    "exceeded your current quota",
  ],
  ["RateLimitError: 429", "RateLimitError"],
  ["Claude AI usage limit reached|1700000000", "usage limit reached"],
  ["Error from provider: rate limit reached, retry later", "rate limit reached"],
  ["provider says rate-limit exceeded", "rate-limit exceeded"],
  ["Error: rate limited by provider", "rate limited"],
  ["429 from the rate limiter", "rate limiter"],
  ["Error: all quotas exhausted", "quotas exhausted"],
  ["error: QUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
  ["code=quotaExceeded", "quotaExceeded"],
  // Glued onto a pane-wide line by the unwrapped read: as printed text, in any case a provider prints it.
  ["Loading providers okNo API key found", "No API key"],
  ["Loading providers okRate limit exceeded", "Rate limit exceeded"],
  ["Loading providers okRate Limit Exceeded", "Rate Limit Exceeded"],
  ["Loading providers okRATE LIMIT EXCEEDED", "RATE LIMIT EXCEEDED"],
  ["Loading providers OKRate limit exceeded", "Rate limit exceeded"],
  ["Loading providers okQuota exceeded for model", "Quota exceeded"],
  ["Loading providers okQuota Exceeded", "Quota Exceeded"],
  ["Loading providers okQUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
  ["Loading providers okrate_limit_exceeded", "rate_limit_exceeded"],
  ["Loading providers okUsage limit reached", "Usage limit reached"],
  ["Loading providers okToo Many Requests", "Too Many Requests"],
];
const HEALTHY: readonly string[] = [
  "const rateLimit = ratelimiter(noApiKey, usageLimit); // SessionCrashed",
  "load is moderate\nlimits apply",
  "load is moderate limits apply",
  "const quotaUsed = 3;",
  "my_quota_check",
  "const e = isQuotaExceeded(r);",
  "handler: onRateLimitExceeded",
  "class RateLimiter {}",
  "if (err instanceof isRateLimitError) retry()",
  "the userQuota field is set",
  "maxQuota of 10",
  "loaded the quota-meter extension",
  "bun run cli --quota=5",
  "set a rate limit of 10 per second",
  "a moderate limit exceeded the budget",
  "const quotaExceededHandler = h;",
  "check the usage limit in settings",
  "❯ \n Pursuing goal (1m)",
];

test("every real failure line in the corpus reports its phrase", () => {
  for (const [text, found] of FAILURES) expect([text, startupFailure(text)]).toEqual([text, found]);
});

test("no code or prose in the corpus is a failure", () => {
  for (const text of HEALTHY) expect([text, startupFailure(text)]).toEqual([text, null]);
});
