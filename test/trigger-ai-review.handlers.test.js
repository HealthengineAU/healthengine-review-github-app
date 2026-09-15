import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/trigger-ai-review.js";
import { KNOWN_PROVIDERS } from "../lib/config.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

// The handlers build their own config via loadAiReviewConfig(context), which
// reads the RAW YAML from context.config(). So we feed the raw `{ providers }`
// shape, not the resolved config object.
function fakeConfig(enabled = KNOWN_PROVIDERS) {
  return { providers: [...enabled] };
}

// Dusty needs an agent proxy to wake as well as the provider being enabled.
// debounce_seconds: 0 so the wake lands on the next tick.
function dustyConfig(enabled = ["dusty"]) {
  return {
    providers: [...enabled],
    agents: [
      {
        name: "dusty",
        bot: "dusty-the-robot[bot]",
        mention: "@acme/dusty\\b",
        events: ["mention"],
        debounce_seconds: 0,
        dispatch: { owner: "HealthengineAU", repo: "dusty" },
      },
    ],
  };
}

function countCalls(octokit, method) {
  return octokit.calls.filter((c) => c.method === method).length;
}

function calls(octokit, method) {
  return octokit.calls.filter((c) => c.method === method);
}

// ---------------------------------------------------------------------------
// issue_comment.created
// ---------------------------------------------------------------------------

test("issue_comment: ignores comments that are not on a pull request", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      issue: { number: 1 /* no pull_request */ },
      comment: { id: 5, body: "roast me auggie", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);
  assert.equal(octokit.calls.length, 0);
});

test("issue_comment: ignores comments authored by bots", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      issue: { number: 1, pull_request: {} },
      comment: { id: 5, body: "roast me auggie", user: { type: "Bot" } },
    },
  });
  await dispatch("issue_comment.created", context);
  assert.equal(octokit.calls.length, 0);
});

test("issue_comment: ignores when the comment already triggers a review", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      issue: { number: 1, pull_request: {} },
      comment: { id: 5, body: "auggie review", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);
  assert.equal(octokit.calls.length, 0);
});

test("issue_comment: 'copilot review' summons Copilot and 👍 reacts", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "copilot review please", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);

  const reactions = octokit.calls.filter(
    (c) => c.method === "rest.reactions.createForIssueComment"
  );
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].args.content, "+1");

  const requests = octokit.calls.filter(
    (c) => c.method === "rest.pulls.requestReviewers"
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].args.reviewers, [
    "copilot-pull-request-reviewer[bot]",
  ]);
});

test("issue_comment: summoning a disabled provider notifies and 👎 reacts", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(["augment"]), // copilot disabled
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "copilot review", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);

  // Posts an explanatory comment...
  const notices = octokit.calls.filter(
    (c) => c.method === "rest.issues.createComment"
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0].args.body, /not currently available/i);

  // ...reacts 👎...
  const reactions = octokit.calls.filter(
    (c) => c.method === "rest.reactions.createForIssueComment"
  );
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].args.content, "-1");

  // ...and does NOT request a reviewer.
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 0);
});

test("issue_comment: standalone 'ai review' picks the only enabled provider", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  // Only copilot enabled → triggerRandomReviewer deterministically picks it.
  const octokit = makeOctokit({ "rest.pulls.get": { data: { additions: 40, deletions: 2 } } });
  const context = makeContext({
    octokit,
    config: fakeConfig(["copilot"]),
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "ai review", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);

  assert.equal(countCalls(octokit, "rest.reactions.createForIssueComment"), 1);
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

test("issue_comment: 'ai review' honours the provider group band for the PR's size", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  // Both enabled, but only copilot is in the band for a 300-line PR.
  const octokit = makeOctokit({ "rest.pulls.get": { data: { additions: 300, deletions: 10 } } });
  const context = makeContext({
    octokit,
    config: {
      ...dustyConfig(["copilot", "dusty"]),
      ai_review: {
        provider_groups: [
          { min_lines_added: 120, max_lines_added: 1500, providers: ["copilot"] },
          { providers: ["dusty"] },
        ],
      },
    },
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "ai review", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
  assert.equal(countCalls(octokit, "rest.actions.createWorkflowDispatch"), 0);
});

test("issue_comment: 'ai review' stays silent when the PR's size is unknown", async () => {
  for (const response of [
    () => {
      throw new Error("boom");
    },
    { data: {} },
  ]) {
    const { app, dispatch } = makeApp();
    register(app);
    const octokit = makeOctokit({ "rest.pulls.get": response });
    const context = makeContext({
      octokit,
      config: fakeConfig(["copilot"]),
      payload: {
        issue: { number: 7, pull_request: {} },
        comment: { id: 5, body: "ai review", user: { type: "User" } },
      },
    });
    await dispatch("issue_comment.created", context);

    assert.equal(countCalls(octokit, "rest.reactions.createForIssueComment"), 0);
    assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 0);
    assert.equal(countCalls(octokit, "rest.issues.createComment"), 0);
  }
});

test("issue_comment: Auggie summon survives failing comment edits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = t.mock.method(console, "error", () => {});
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.issues.updateComment": () => {
      throw new Error("api down");
    },
  });
  const context = makeContext({
    octokit,
    config: fakeConfig(["augment"]),
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "roast me auggie", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);

  // Fire the +10s marker edit and the +20s acknowledgement check; both hit the
  // failing updateComment and must be caught + logged, not left as unhandled
  // rejections (which would crash the process).
  t.mock.timers.tick(21_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  assert.equal(errors.mock.callCount(), 2);
});

test("issue_comment: an unrelated comment does nothing", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "looks good, shipping it", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);
  assert.equal(octokit.calls.length, 0);
});

// ---------------------------------------------------------------------------
// pull_request.labeled
// ---------------------------------------------------------------------------

test("pull_request.labeled: an unrelated label is ignored", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      pull_request: { number: 3 },
      label: { name: "bug" },
    },
  });
  await dispatch("pull_request.labeled", context);
  assert.equal(octokit.calls.length, 0);
});

test("pull_request.labeled: a skip-style label is ignored", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      pull_request: { number: 3 },
      label: { name: "no-ai-review" },
    },
  });
  await dispatch("pull_request.labeled", context);
  assert.equal(octokit.calls.length, 0);
});

test("pull_request.labeled: 'ai-review' removes the label and triggers a review", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(["copilot"]), // deterministic random pick
    payload: {
      pull_request: { number: 3 },
      label: { name: "ai-review" },
    },
  });
  await dispatch("pull_request.labeled", context);

  const removals = octokit.calls.filter(
    (c) => c.method === "rest.issues.removeLabel"
  );
  assert.equal(removals.length, 1);
  assert.equal(removals[0].args.name, "ai-review");

  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

// ---------------------------------------------------------------------------
// pull_request.review_requested (team requests)
// ---------------------------------------------------------------------------

test("review_requested: non-team requests are ignored", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: { pull_request: { number: 3 } /* no requested_team */ },
  });
  await dispatch("pull_request.review_requested", context);
  assert.equal(octokit.calls.length, 0);
});

test("review_requested: an unrelated team is ignored", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(),
    payload: {
      pull_request: { number: 3 },
      requested_team: { slug: "backend", name: "Backend" },
    },
  });
  await dispatch("pull_request.review_requested", context);
  assert.equal(octokit.calls.length, 0);
});

test("review_requested: a 'dusty' team summons Dusty and leaves the request in place", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: dustyConfig(),
    payload: {
      pull_request: { number: 3 },
      requested_team: { slug: "dusty", name: "Dusty" },
      sender: { login: "david" },
    },
  });
  await dispatch("pull_request.review_requested", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  const comments = calls(octokit, "rest.issues.createComment");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].args.body, "@acme/dusty review");

  // Bot-authored, so the comment can't wake Dusty — the summon dispatches too.
  const wakes = calls(octokit, "rest.actions.createWorkflowDispatch");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].args.repo, "dusty");
  assert.deepEqual(wakes[0].args.inputs, {
    event: "mention",
    repo: context.repo().repo,
    pr: "3",
    actor: "david",
    body: "@acme/dusty review",
  });

  // Like Auggie, the team request stays until the review lands.
  assert.equal(countCalls(octokit, "pulls.removeRequestedReviewers"), 0);
});

test("review_requested: a 'dusty' team with Dusty disabled clears the request and explains", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: dustyConfig(["copilot"]),
    payload: {
      pull_request: { number: 3 },
      requested_team: { slug: "dusty", name: "Dusty" },
      sender: { login: "david" },
    },
  });
  await dispatch("pull_request.review_requested", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(countCalls(octokit, "pulls.removeRequestedReviewers"), 1);
  assert.equal(countCalls(octokit, "rest.actions.createWorkflowDispatch"), 0);

  const comments = calls(octokit, "rest.issues.createComment");
  assert.equal(comments.length, 1);
  assert.match(comments[0].args.body, /\*\*Dusty\*\* is not currently available/);
});

// ---------------------------------------------------------------------------
// pull_request_review.submitted (clearing a provider's team request)
// ---------------------------------------------------------------------------

test("review submitted: Dusty's review clears the dusty team request", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: dustyConfig(),
    payload: {
      pull_request: {
        number: 3,
        requested_teams: [{ slug: "dusty", name: "Dusty" }, { slug: "backend", name: "Backend" }],
      },
      review: { user: { login: "dusty-the-robot[bot]", type: "Bot" } },
    },
  });
  await dispatch("pull_request_review.submitted", context);

  const removals = calls(octokit, "pulls.removeRequestedReviewers");
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0].args.team_reviewers, ["dusty"]);
});

test("review submitted: a human whose login contains a provider key clears nothing", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: dustyConfig(),
    payload: {
      pull_request: { number: 3, requested_teams: [{ slug: "dusty", name: "Dusty" }] },
      review: { user: { login: "dusty-rhodes", type: "User" } },
    },
  });
  await dispatch("pull_request_review.submitted", context);
  assert.equal(octokit.calls.length, 0);
});

test("review_requested: a 'dusty' team with no agent proxy is treated as unavailable", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    // Enabled in `providers` — which is how the no-config default arrives — but
    // with no `agents` entry there is nothing to summon.
    config: { providers: ["dusty"] },
    payload: {
      pull_request: { number: 3 },
      requested_team: { slug: "dusty", name: "Dusty" },
      sender: { login: "david" },
    },
  });
  await dispatch("pull_request.review_requested", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(countCalls(octokit, "pulls.removeRequestedReviewers"), 1);
  assert.equal(countCalls(octokit, "rest.actions.createWorkflowDispatch"), 0);
  assert.match(calls(octokit, "rest.issues.createComment")[0].args.body, /not currently available/);
});

test("issue_comment: 'ai review' summons nothing when the only provider is unreachable", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: { providers: ["dusty"] },
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 5, body: "ai review", user: { type: "User" } },
    },
  });
  await dispatch("issue_comment.created", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(countCalls(octokit, "rest.issues.createComment"), 0);
  assert.equal(countCalls(octokit, "rest.actions.createWorkflowDispatch"), 0);
});

test("review_requested: an 'ai-review' team clears the request and triggers a review", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: fakeConfig(["copilot"]),
    payload: {
      pull_request: { number: 3 },
      requested_team: { slug: "ai-review", name: "AI Review" },
    },
  });
  await dispatch("pull_request.review_requested", context);

  assert.equal(countCalls(octokit, "pulls.removeRequestedReviewers"), 1);
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});
