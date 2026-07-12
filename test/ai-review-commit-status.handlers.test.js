import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/ai-review-commit-status.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

// The status handlers debounce their work behind an 800ms trailing timer, then
// run an async update. This helper advances the mocked clock and lets the
// resulting microtasks settle.
async function flushDebounce(t) {
  t.mock.timers.tick(1000);
  // Let the async updateAIReviewStatus() chain resolve.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function statusCalls(octokit) {
  return octokit.calls.filter(
    (c) => c.method === "rest.repos.createCommitStatus"
  );
}

test("skip-ai-review label short-circuits to a success status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      pull_request: {
        number: 1,
        state: "open",
        head: { sha: "abc123" },
        user: { login: "david", type: "User" },
        labels: [{ name: "skip-ai-review" }],
      },
    },
  });

  await dispatch("pull_request.opened", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].args.state, "success");
  assert.match(statuses[0].args.description, /skipped/i);
  // Short-circuit: it should never fetch reviews/comments.
  assert.equal(octokit.calls.some((c) => c.method === "graphql"), false);
});

test("a bot-authored PR skips the AI review with a success status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      pull_request: {
        number: 1,
        state: "open",
        head: { sha: "abc123" },
        user: { login: "dependabot[bot]", type: "Bot" },
        labels: [],
      },
    },
  });

  await dispatch("pull_request.opened", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].args.state, "success");
  assert.match(statuses[0].args.description, /skipped for author/i);
});

test("a closed PR produces no status update", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      pull_request: {
        number: 1,
        state: "closed",
        head: { sha: "abc123" },
        user: { login: "david", type: "User" },
        labels: [],
      },
    },
  });

  await dispatch("pull_request.synchronize", context);
  await flushDebounce(t);

  assert.equal(statusCalls(octokit).length, 0);
});

test("bursts of events are debounced into a single status update", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const makePayload = () => ({
    pull_request: {
      number: 1,
      state: "open",
      head: { sha: "abc123" },
      user: { login: "david", type: "User" },
      labels: [{ name: "skip-ai-review" }],
    },
  });

  // Five events fire for the same PR (same owner/repo/number) in quick
  // succession — the debounce key is owner/repo#number.
  for (let i = 0; i < 5; i++) {
    await dispatch(
      "pull_request.synchronize",
      makeContext({ octokit, repo: "burst-repo", payload: makePayload() })
    );
  }
  await flushDebounce(t);

  // Trailing-edge debounce → exactly one status write.
  assert.equal(statusCalls(octokit).length, 1);
});

test("removing the skip label reverts the gate to pending immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      label: { name: "skip-ai-review" },
      pull_request: {
        number: 1,
        state: "open",
        head: { sha: "abc123" },
        user: { login: "david", type: "User" },
        labels: [],
      },
    },
  });

  await dispatch("pull_request.unlabeled", context);

  // The pending revert is written synchronously, before the debounce fires.
  const pending = statusCalls(octokit).find((c) => c.args.state === "pending");
  assert.ok(pending, "expected an immediate pending status");
  assert.match(pending.args.description, /label removed/i);
});

test("a non-skip label removal is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      label: { name: "some-other-label" },
      pull_request: {
        number: 1,
        state: "open",
        head: { sha: "abc123" },
        user: { login: "david", type: "User" },
        labels: [],
      },
    },
  });

  await dispatch("pull_request.unlabeled", context);
  await flushDebounce(t);

  assert.equal(octokit.calls.length, 0);
});
