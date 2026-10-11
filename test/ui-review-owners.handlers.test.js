import { test } from "node:test";
import assert from "node:assert/strict";

import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";
import { register } from "../lib/ui-review-owners.js";

const COMMENT_URL = "https://github.com/acme/catalyst/pull/57#issuecomment-1";
const tag = (notify, owners) => `<!-- ui-owners notify=${notify} ${owners.join(" ")} -->`;
const toolComment = (body) => ({ id: 1, html_url: COMMENT_URL, body: `<!-- found-pixel-comment -->\n${body}\n## 📘 UI Review` });

const pr = ({ draft = false, state = "open", author = "dev" } = {}) => ({ number: 57, draft, state, user: { login: author } });

function setup({ current = pr(), comments = [], timeline = [] } = {}) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.pulls.get": { data: current },
    "paginate:rest.issues.listComments": comments,
    "paginate:rest.issues.listEventsForTimeline": timeline,
  });
  const calls = (method) => octokit.calls.filter((c) => c.method === method).map((c) => c.args);
  const context = (payload) => makeContext({ octokit, payload, owner: "acme", repo: "catalyst" });
  return { dispatch, octokit, calls, context };
}

const commentEvent = (body, from) => ({
  issue: { number: 57, pull_request: {} },
  comment: { id: 1, body },
  ...(from === undefined ? {} : { changes: { body: { from } } }),
});

const invited = (t) => t.calls("rest.pulls.requestReviewers").map(({ reviewers, team_reviewers }) => ({ reviewers, team_reviewers }));

test("invites owning teams and users when found-pixel's comment asks", async () => {
  const comment = toolComment(tag("invite", ["@acme/pingu", "@someone"]));
  const t = setup({ comments: [comment] });
  await t.dispatch("issue_comment.created", t.context(commentEvent(comment.body)));
  assert.deepEqual(invited(t), [{ reviewers: ["someone"], team_reviewers: ["pingu"] }]);
  assert.equal(t.calls("rest.pulls.requestReviewers")[0].pull_number, 57);
});

test("waits for drafts to be marked ready, then invites", async () => {
  const comment = toolComment(tag("invite", ["@acme/pingu"]));
  const t = setup({ current: pr({ draft: true }), comments: [comment] });
  await t.dispatch("issue_comment.created", t.context(commentEvent(comment.body)));
  assert.deepEqual(invited(t), []);

  await t.dispatch("pull_request.ready_for_review", t.context({ pull_request: pr() }));
  assert.deepEqual(invited(t), [{ reviewers: [], team_reviewers: ["pingu"] }]);
});

test("never re-invites anyone requested before, who reviewed, or the author", async () => {
  const comment = toolComment(tag("invite", ["@acme/pingu", "@acme/jarvis", "@reviewer", "@dev", "@acme/marketplace"]));
  const t = setup({
    comments: [comment],
    timeline: [
      { event: "review_requested", requested_team: { slug: "pingu" } },
      { event: "review_request_removed", requested_team: { slug: "pingu" } },
      { event: "reviewed", user: { login: "Reviewer" } },
      { event: "review_requested", requested_team: { slug: "Jarvis" } },
    ],
  });
  await t.dispatch("pull_request.ready_for_review", t.context({ pull_request: pr() }));
  assert.deepEqual(invited(t), [{ reviewers: [], team_reviewers: ["marketplace"] }]);
});

test("skips teams from other orgs and does nothing when no one is left", async () => {
  const comment = toolComment(tag("invite", ["@other/team"]));
  const t = setup({ comments: [comment] });
  await t.dispatch("pull_request.ready_for_review", t.context({ pull_request: pr() }));
  assert.deepEqual(invited(t), []);
});

test("mentions owners once, in a new comment", async () => {
  const comment = toolComment(tag("mention", ["@acme/pingu", "@acme/jarvis"]));
  const t = setup({ comments: [comment] });
  await t.dispatch("pull_request.ready_for_review", t.context({ pull_request: pr() }));
  assert.deepEqual(t.calls("rest.issues.createComment").map((a) => a.body), [
    [
      "<!-- ui-owners-notified @acme/pingu @acme/jarvis -->",
      `👀 @acme/pingu @acme/jarvis — this PR changes stories you own. See the [UI Review](${COMMENT_URL}).`,
    ].join("\n"),
  ]);
  assert.deepEqual(invited(t), []);
});

test("mentions only owners not mentioned or requested before", async () => {
  const comment = toolComment(tag("mention", ["@acme/pingu", "@acme/jarvis", "@acme/payments"]));
  const earlier = { id: 2, body: "<!-- ui-owners-notified @acme/pingu -->\n👀 @acme/pingu" };
  const t = setup({
    comments: [comment, earlier],
    timeline: [{ event: "review_requested", requested_team: { slug: "payments" } }],
  });
  await t.dispatch("pull_request.ready_for_review", t.context({ pull_request: pr() }));
  assert.match(t.calls("rest.issues.createComment")[0].body, /^<!-- ui-owners-notified @acme\/jarvis -->/);
});

test("comments without the tag, or edits that keep the same owners, are ignored", async () => {
  const body = toolComment(tag("invite", ["@acme/pingu"])).body;
  const t = setup();
  await t.dispatch("issue_comment.created", t.context(commentEvent("LGTM")));
  await t.dispatch("issue_comment.edited", t.context(commentEvent(`${body}\n> - [x] approved`, body)));
  await t.dispatch("issue_comment.created", t.context({ ...commentEvent(body), issue: { number: 57 } }));
  assert.equal(t.octokit.calls.length, 0);
});

test("an edit that changes the owners is re-evaluated", async () => {
  const before = toolComment(tag("invite", ["@acme/pingu"])).body;
  const after = toolComment(tag("invite", ["@acme/pingu", "@acme/jarvis"]));
  const t = setup({ comments: [after], timeline: [{ event: "review_requested", requested_team: { slug: "pingu" } }] });
  await t.dispatch("issue_comment.edited", t.context(commentEvent(after.body, before)));
  assert.deepEqual(invited(t), [{ reviewers: [], team_reviewers: ["jarvis"] }]);
});

test("closed pull requests are left alone", async () => {
  const comment = toolComment(tag("invite", ["@acme/pingu"]));
  const t = setup({ current: pr({ state: "closed" }), comments: [comment] });
  await t.dispatch("issue_comment.created", t.context(commentEvent(comment.body)));
  assert.deepEqual(invited(t), []);
});
