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

test("a dependabot-authored PR skips the AI review by default with a success status", async (t) => {
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

test("skip_authors config replaces the default skip list", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: { ai_review: { skip_authors: ["renovate[bot]"] } },
    payload: {
      pull_request: {
        number: 1,
        state: "open",
        head: { sha: "abc123" },
        user: { login: "Renovate[bot]", type: "Bot" },
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

test("a bot author not on the skip list gets the normal review flow", async (t) => {
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
        user: { login: "renovate[bot]", type: "Bot" },
        labels: [],
      },
    },
  });

  await dispatch("pull_request.opened", context);
  await flushDebounce(t);

  // No skip short-circuit: it proceeds to the review/comment fetches (and,
  // with no bot activity, posts no status at all).
  assert.equal(octokit.calls.some((c) => c.method === "graphql"), true);
  assert.equal(statusCalls(octokit).length, 0);
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

// ---------------------------------------------------------------------------
// "Requested …" statuses for pending AI review requests
// ---------------------------------------------------------------------------

function makeOpenPr(overrides = {}) {
  return {
    number: 1,
    state: "open",
    head: { sha: "abc123" },
    user: { login: "david", type: "User" },
    labels: [],
    requested_reviewers: [],
    requested_teams: [],
    ...overrides,
  };
}

test("our Auggie summon comment produces a green 'Requested Auggie' status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const summonComment = {
    user: { login: "healthengine-review[bot]", type: "Bot", id: 55 },
    body: "auggie review",
    created_at: "2026-07-01T00:00:00Z",
  };
  const octokit = makeOctokit({
    "rest.pulls.get": { data: makeOpenPr() },
    "paginate:rest.issues.listComments": [summonComment],
  });
  const context = makeContext({
    octokit,
    payload: {
      issue: { number: 1, pull_request: {} },
      comment: summonComment,
    },
  });

  await dispatch("issue_comment.created", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].args.state, "success");
  assert.match(statuses[0].args.description, /Requested Auggie/);
});

test("a human-typed 'auggie review' command also refreshes the status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const command = {
    user: { login: "david", type: "User", id: 1 },
    body: "auggie review",
    created_at: "2026-07-01T00:00:00Z",
  };
  const octokit = makeOctokit({
    "rest.pulls.get": { data: makeOpenPr() },
    "paginate:rest.issues.listComments": [command],
  });
  const context = makeContext({
    octokit,
    payload: {
      issue: { number: 1, pull_request: {} },
      comment: command,
    },
  });

  await dispatch("issue_comment.created", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].args.description, /Requested Auggie/);
});

test("an unrelated human comment does not refresh the status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      issue: { number: 1, pull_request: {} },
      comment: { user: { login: "david", type: "User" }, body: "nice work!" },
    },
  });

  await dispatch("issue_comment.created", context);
  await flushDebounce(t);

  assert.equal(octokit.calls.length, 0);
});

test("an Auggie team request produces a 'Requested Auggie' status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      pull_request: makeOpenPr({
        requested_teams: [{ slug: "auggie", name: "Auggie" }],
      }),
    },
  });

  await dispatch("pull_request.review_requested", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].args.state, "success");
  assert.match(statuses[0].args.description, /Requested Auggie/);
});

test("a requested Copilot reviewer still produces 'Requested Copilot'", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    payload: {
      pull_request: makeOpenPr({
        requested_reviewers: [
          { login: "copilot-pull-request-reviewer[bot]", type: "Bot", id: 9 },
        ],
      }),
    },
  });

  await dispatch("pull_request.review_requested", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].args.description, /Requested Copilot/);
});

test("a running gitStream automation shows 'Requested LinearB'", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.repos.getCombinedStatusForRef": {
      data: { statuses: [{ context: "gitStream.cm", state: "pending" }] },
    },
  });
  const context = makeContext({
    octokit,
    payload: { pull_request: makeOpenPr() },
  });

  await dispatch("pull_request.synchronize", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].args.state, "success");
  assert.match(statuses[0].args.description, /Requested LinearB/);
});

test("a delivered Augment review wins over its own summon", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { app, dispatch } = makeApp();
  register(app);
  const auggie = { login: "augmentcode[bot]", type: "Bot", id: 77 };
  const octokit = makeOctokit({
    "paginate:rest.pulls.listReviews": [
      {
        user: auggie,
        body: "Here is my review",
        submitted_at: "2026-07-01T00:05:00Z",
        html_url: "https://example.com/review",
      },
    ],
    "paginate:rest.issues.listComments": [
      {
        user: { login: "david", type: "User", id: 1 },
        body: "auggie review",
        created_at: "2026-07-01T00:00:00Z",
      },
    ],
  });
  const context = makeContext({
    octokit,
    payload: {
      review: { user: auggie },
      pull_request: makeOpenPr(),
    },
  });

  await dispatch("pull_request_review.submitted", context);
  await flushDebounce(t);

  const statuses = statusCalls(octokit);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].args.description, /Reviewed by Auggie/);
  assert.doesNotMatch(statuses[0].args.description, /Requested/);
});
