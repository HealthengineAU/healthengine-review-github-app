import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/augment-fallback.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

const OUT_OF_CREDITS =
  "Looks like you're out of credits for this review. Head to your account settings to top up and keep reviews running. https://app.augmentcode.com/account/subscription";

const AUGGIE = { login: "augmentcode[bot]", type: "Bot" };

// Dusty needs an agent proxy to wake as well as the provider being enabled.
// debounce_seconds: 0 so the wake lands on the next tick.
function dustyConfig(enabled = ["augment", "dusty"]) {
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

function calls(octokit, method) {
  return octokit.calls.filter((c) => c.method === method);
}

function failurePayload(comments = []) {
  return {
    payload: {
      issue: { number: 9, pull_request: {}, user: { login: "kim" } },
      comment: {
        id: 11,
        body: OUT_OF_CREDITS,
        user: AUGGIE,
        created_at: "2026-11-01T04:00:00Z",
      },
    },
    responses: { "paginate:rest.issues.listComments": comments },
  };
}

test("Auggie out of credits: summons Dusty for whoever asked", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const { payload, responses } = failurePayload([
    {
      body: "auggie review",
      user: { login: "sam", type: "User" },
      created_at: "2026-11-01T03:00:00Z",
    },
  ]);
  const octokit = makeOctokit(responses);
  const context = makeContext({ octokit, config: dustyConfig(), payload });

  await dispatch("issue_comment.created", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  const comments = calls(octokit, "rest.issues.createComment");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].args.body, "@acme/dusty review");

  const wakes = calls(octokit, "rest.actions.createWorkflowDispatch");
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].args.inputs, {
    event: "mention",
    repo: context.repo().repo,
    pr: "9",
    actor: "sam",
    body: "@acme/dusty review",
  });
});

test("Auggie out of credits: edits of the same failure hand off only once", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const { payload, responses } = failurePayload([
    {
      body: "@acme/dusty review",
      user: { login: "pr-bot[bot]", type: "Bot" },
      created_at: "2026-11-01T04:00:01Z",
    },
  ]);
  const octokit = makeOctokit(responses);
  const context = makeContext({ octokit, config: dustyConfig(), payload });

  await dispatch("issue_comment.edited", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(calls(octokit, "rest.issues.createComment").length, 0);
  assert.equal(calls(octokit, "rest.actions.createWorkflowDispatch").length, 0);
});

test("Auggie out of credits: stays out of it when Dusty isn't a provider here", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const { payload, responses } = failurePayload();
  const octokit = makeOctokit(responses);
  const context = makeContext({
    octokit,
    config: dustyConfig(["augment", "copilot"]),
    payload,
  });

  await dispatch("issue_comment.created", context);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(octokit.calls.length, 0);
});

test("Auggie's other comments, and other authors, change nothing", async () => {
  for (const comment of [
    { id: 1, body: "<!-- augment-pr-summary -->\nAuggie PR Summary", user: AUGGIE },
    { id: 2, body: OUT_OF_CREDITS, user: { login: "sam", type: "User" } },
  ]) {
    const { app, dispatch } = makeApp();
    register(app);
    const octokit = makeOctokit();
    const context = makeContext({
      octokit,
      config: dustyConfig(),
      payload: { issue: { number: 9, pull_request: {}, user: { login: "kim" } }, comment },
    });

    await dispatch("issue_comment.created", context);
    await new Promise((resolve) => setTimeout(resolve, 1));

    assert.equal(octokit.calls.length, 0);
  }
});

test("Auggie out of credits on an issue that isn't a PR changes nothing", async () => {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config: dustyConfig(),
    payload: {
      issue: { number: 9, user: { login: "kim" } },
      comment: { id: 11, body: OUT_OF_CREDITS, user: AUGGIE },
    },
  });

  await dispatch("issue_comment.created", context);
  assert.equal(octokit.calls.length, 0);
});
