import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/dismiss-bot-approvals.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

async function submit({ user, state = "approved", config }) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  const context = makeContext({
    octokit,
    config,
    payload: { pull_request: { number: 7 }, review: { id: 42, state, user } },
  });
  await dispatch("pull_request_review.submitted", context);
  return octokit.calls.filter((c) => c.method === "rest.pulls.dismissReview");
}

const dusty = { login: "dusty-the-robot[bot]", type: "Bot" };

test("dismisses a bot approval by default", async () => {
  const calls = await submit({ user: dusty });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.review_id, 42);
  assert.equal(calls[0].args.pull_number, 7);
});

test("ignores human approvals, even with a login ending in b/o/t", async () => {
  assert.equal((await submit({ user: { login: "scott", type: "User" } })).length, 0);
});

test("ignores bot reviews that aren't approvals", async () => {
  assert.equal((await submit({ user: dusty, state: "commented" })).length, 0);
});

test("respects negated patterns", async () => {
  const config = { dismiss_bot_approvals: { authors: ["*[bot]", "!dusty-the-robot[bot]"] } };
  assert.equal((await submit({ user: dusty, config })).length, 0);
});

test("an empty list dismisses nothing", async () => {
  const config = { dismiss_bot_approvals: { authors: [] } };
  assert.equal((await submit({ user: dusty, config })).length, 0);
});
