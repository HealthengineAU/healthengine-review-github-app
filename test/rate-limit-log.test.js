import { test } from "node:test";
import assert from "node:assert/strict";

import { logRateLimit, withRateLimitLog } from "../lib/rate-limit-log.js";
import { makeApp } from "./helpers/mock-github.js";

const headers = (remaining, resource) => ({
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-limit": "12500",
  "x-ratelimit-resource": resource,
});

test("logs remaining quota at most every 5 minutes per resource", (t) => {
  const info = t.mock.method(console, "info", () => {});

  logRateLimit(headers(9000, "core-a"), 0);
  logRateLimit(headers(8900, "core-a"), 60_000);
  logRateLimit(headers(8800, "graphql-a"), 60_000);
  logRateLimit(headers(8700, "core-a"), 5 * 60_000);

  assert.deepEqual(info.mock.calls.map((c) => c.arguments[0]), [
    "[rate-limit] core-a: 9000/12500 remaining",
    "[rate-limit] graphql-a: 8800/12500 remaining",
    "[rate-limit] core-a: 8700/12500 remaining",
  ]);
});

test("warns every minute once quota drops below 20%", (t) => {
  const warn = t.mock.method(console, "warn", () => {});

  logRateLimit(headers(2000, "core-b"), 0);
  logRateLimit(headers(1900, "core-b"), 30_000);
  logRateLimit(headers(1800, "core-b"), 60_000);

  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[1].arguments[0], /core-b: 1800\/12500/);
});

test("ignores responses without rate limit headers", (t) => {
  const info = t.mock.method(console, "info", () => {});
  logRateLimit({}, 0);
  logRateLimit(undefined, 0);
  assert.equal(info.mock.callCount(), 0);
});

test("hooks each event's octokit once, before the handler runs", async () => {
  const { app, dispatch } = makeApp();
  const wrapped = withRateLimitLog(app);
  const hooks = [];
  const octokit = { hook: { after: (name, fn) => hooks.push(name) } };
  const seen = [];

  wrapped.on("pull_request.opened", (context) => seen.push(["a", hooks.length, context]));
  wrapped.on(["pull_request.opened"], (context) => seen.push(["b", hooks.length, context]));

  const context = { octokit };
  await dispatch("pull_request.opened", context);

  assert.deepEqual(hooks, ["request"]);
  assert.deepEqual(seen, [["a", 1, context], ["b", 1, context]]);
});
