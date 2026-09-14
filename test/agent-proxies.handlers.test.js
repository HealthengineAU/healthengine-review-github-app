import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/agent-proxies.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

// One fully-enabled agent, unless a test overrides it. context.config() returns
// the RAW yaml; loadAiReviewConfig normalizes it.
function agentConfig(overrides = {}) {
  return {
    agents: [
      {
        name: "dusty",
        bot: "dusty-the-robot[bot]",
        mention: "@dusty\\b",
        checks: "^buildkite/",
        events: ["review", "comment", "check", "mention"],
        ignore_users: ["healthengine-sre"],
        debounce_seconds: 45,
        dispatch: { owner: "acme", repo: "dusty", workflow: "webhook_event.yml", ref: "main" },
        ...overrides,
      },
    ],
  };
}

function dispatches(octokit) {
  return octokit.calls.filter((c) => c.method === "rest.actions.createWorkflowDispatch");
}

// Dispatch a synthetic webhook, then run out the debounce timer and let the
// async dispatch settle.
async function fire(t, { event, payload, config = agentConfig(), octokit, repo }) {
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  } catch {
    // already enabled earlier in the same test
  }
  const { app, dispatch } = makeApp();
  register(app);
  await dispatch(event, makeContext({ octokit, config, payload, ...(repo ? { repo } : {}) }));
  t.mock.timers.tick(46_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// An octokit whose 👀 comes back with an id, so the swap to 👍 can delete it.
const SEEN_ID = 555;
function ackingOctokit(responses = {}) {
  return makeOctokit({
    "rest.reactions.createForIssueComment": { data: { id: SEEN_ID } },
    ...responses,
  });
}

function reactions(octokit) {
  return octokit.calls.filter((c) => c.method === "rest.reactions.createForIssueComment");
}

// ---------------------------------------------------------------------------
// pull_request_review.submitted
// ---------------------------------------------------------------------------

test("review on a Dusty PR dispatches with the review author as actor", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.submitted",
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "david", type: "User" }, state: "changes_requested", body: "please fix" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {
    owner: "acme",
    repo: "dusty",
    workflow_id: "webhook_event.yml",
    ref: "main",
    inputs: { event: "review", repo: "svc", pr: "11", actor: "david", body: "please fix" },
  });
});

test("an approval does not dispatch", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.submitted",
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "david", type: "User" }, state: "approved", body: "" },
    },
  });
  assert.equal(dispatches(octokit).length, 0);
});

// ---------------------------------------------------------------------------
// issue_comment.created
// ---------------------------------------------------------------------------

test("human comment on a Dusty PR dispatches a comment event", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 12, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
      comment: { user: { login: "david", type: "User" }, body: "nit here" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.inputs.event, "comment");
  assert.equal(calls[0].args.inputs.pr, "12");
});

test("@mention on a foreign PR dispatches a mention event", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 13, pull_request: {}, user: { login: "someone-else" } },
      comment: { user: { login: "david", type: "User" }, body: "cc @dusty" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.inputs.event, "mention");
});

test("bot comments are ignored", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 14, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
      comment: { user: { login: "screenshot[bot]", type: "Bot" }, body: "here is a screenshot @dusty" },
    },
  });
  assert.equal(dispatches(octokit).length, 0);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("a failing buildkite status on a Dusty PR dispatches a check event", async (t) => {
  const octokit = makeOctokit({
    "rest.repos.listPullRequestsAssociatedWithCommit": {
      data: [
        { number: 20, state: "open", user: { login: "dusty-the-robot[bot]" } },
        { number: 21, state: "open", user: { login: "someone-else" } },
      ],
    },
  });
  await fire(t, {
    event: "status",
    octokit,
    payload: {
      repository: { name: "svc" },
      state: "failure",
      context: "buildkite/test",
      sha: "deadbeef",
      sender: { login: "buildkite[bot]" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1); // only the Dusty-owned PR
  assert.deepEqual(calls[0].args.inputs, {
    event: "check", repo: "svc", pr: "20", actor: "buildkite[bot]", body: "failure: buildkite/test",
  });
});

test("a pending status never looks up PRs", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "status",
    octokit,
    payload: {
      repository: { name: "svc" },
      state: "pending",
      context: "buildkite/test",
      sha: "deadbeef",
    },
  });
  assert.equal(octokit.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Dormant when unconfigured
// ---------------------------------------------------------------------------

test("no agents configured → nothing dispatches", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.submitted",
    config: {},
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "david", type: "User" }, state: "changes_requested", body: "x" },
    },
  });
  assert.equal(octokit.calls.length, 0);
});

test("an edited review dispatches too (Copilot never emits submitted)", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.edited",
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "Copilot", type: "Bot" }, state: "commented", body: "1 suggestion" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.inputs.actor, "Copilot");
});

// ---------------------------------------------------------------------------
// 👀 → 👍 acknowledgements
// ---------------------------------------------------------------------------

test("a comment that wakes Dusty is 👀 on arrival and 👍 once the dispatch lands", async (t) => {
  const octokit = ackingOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 30, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
      comment: { id: 900, user: { login: "david", type: "User" }, body: "nit here" },
    },
  });
  assert.equal(dispatches(octokit).length, 1);
  assert.deepEqual(
    reactions(octokit).map((c) => [c.args.comment_id, c.args.content]),
    [[900, "eyes"], [900, "+1"]],
  );

  // The 👀 comes down only after the 👍 is up.
  const removals = octokit.calls.filter((c) => c.method === "rest.reactions.deleteForIssueComment");
  assert.equal(removals.length, 1);
  assert.equal(removals[0].args.reaction_id, SEEN_ID);
  assert.ok(octokit.calls.indexOf(removals[0]) > octokit.calls.indexOf(reactions(octokit)[1]));
});

test("the 👀 goes up before the debounce, not after the dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const octokit = ackingOctokit();
  const { app, dispatch } = makeApp();
  register(app);
  await dispatch(
    "issue_comment.created",
    makeContext({
      octokit,
      config: agentConfig(),
      repo: "early",
      payload: {
        repository: { name: "early" },
        issue: { number: 33, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
        comment: { id: 940, user: { login: "david", type: "User" }, body: "nit" },
      },
    }),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Debounce still pending: seen, but nothing queued.
  assert.equal(dispatches(octokit).length, 0);
  assert.deepEqual(reactions(octokit).map((c) => c.args.content), ["eyes"]);
});

test("a failed dispatch leaves the 👀 standing and no 👍", async (t) => {
  const octokit = ackingOctokit({
    "rest.actions.createWorkflowDispatch": () => {
      throw Object.assign(new Error("nope"), { status: 404 });
    },
  });
  const errors = t.mock.method(console, "error", () => {});
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 31, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
      comment: { id: 901, user: { login: "david", type: "User" }, body: "nit here" },
    },
  });
  assert.deepEqual(reactions(octokit).map((c) => c.args.content), ["eyes"]);
  assert.equal(octokit.calls.filter((c) => c.method === "rest.reactions.deleteForIssueComment").length, 0);
  assert.equal(errors.mock.callCount(), 1);
});

test("every comment in a debounced burst is acknowledged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const octokit = ackingOctokit();
  const { app, dispatch } = makeApp();
  register(app);
  for (const id of [910, 911]) {
    await dispatch(
      "issue_comment.created",
      makeContext({
        octokit,
        config: agentConfig(),
        repo: "burst",
        payload: {
          repository: { name: "burst" },
          issue: { number: 32, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
          comment: { id, user: { login: "david", type: "User" }, body: "nit" },
        },
      }),
    );
  }
  t.mock.timers.tick(46_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  assert.equal(dispatches(octokit).length, 1); // one wake
  assert.deepEqual(
    reactions(octokit).map((c) => [c.args.comment_id, c.args.content]),
    [[910, "eyes"], [911, "eyes"], [910, "+1"], [911, "+1"]],
  );
});

test("a human reply on an issue in Dusty's own repo goes straight to 👍", async (t) => {
  const octokit = ackingOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    repo: "dusty",
    payload: {
      repository: { name: "dusty" },
      issue: { number: 149, state: "open", user: { login: "dusty-the-robot[bot]" } },
      comment: { id: 920, user: { login: "david", type: "User" }, body: "and now the other thing" },
    },
  });
  assert.equal(dispatches(octokit).length, 0);
  assert.deepEqual(reactions(octokit).map((c) => c.args), [
    { owner: "acme", repo: "dusty", comment_id: 920, content: "+1" },
  ]);
});

test("an issue comment outside Dusty's own repo is left alone", async (t) => {
  const octokit = ackingOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 40, state: "open", user: { login: "david" } },
      comment: { id: 930, user: { login: "david", type: "User" }, body: "unrelated issue chatter" },
    },
  });
  assert.equal(octokit.calls.length, 0);
});
