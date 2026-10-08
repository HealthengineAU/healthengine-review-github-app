import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/ui-review-approvals.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

const SHA = "3897e0b2a142230837e29e68dc4b18a8d318166e";
const URL = (fp) => `https://visreg.he0.io/?r=catalyst&b=feature-x${fp ? `&fp=${fp}` : ""}`;
const STAMP = (fp, name = "Reece Como") => `<!-- ui-approved by=reececomo name="${name}" fp=${fp} -->`;

const toolComment = (id, fp, { stampFp, suite } = {}) => ({
  id,
  body: [
    suite ? `<!-- visreg-comment:${suite} -->` : "<!-- found-pixel-comment -->",
    `<!-- ui-review fp=${fp} -->`,
    "### 📘 UI Review",
    ...(stampFp ? [STAMP(stampFp)] : []),
  ].join("\n"),
});

const pr = ({ labels = [], number = 57 } = {}) => ({
  number,
  state: "open",
  head: { sha: SHA },
  labels: labels.map((name) => ({ name })),
});

const statusPayload = ({ state = "pending", context = "UI Review", description = "3 modified", fp = "cb4f8904" } = {}) => ({
  sha: SHA, state, context, description, target_url: URL(fp), repository: { name: "catalyst" },
});

function setup({ prs = [pr()], comments = [], statuses = [], user = { name: "Reece Como" } } = {}) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.repos.listPullRequestsAssociatedWithCommit": { data: prs },
    "paginate:rest.issues.listComments": comments,
    "rest.repos.getCombinedStatusForRef": { data: { statuses } },
    "rest.users.getByUsername": { data: user },
  });
  const calls = (method) => octokit.calls.filter((c) => c.method === method).map((c) => c.args);
  return { dispatch, octokit, calls, context: (payload) => makeContext({ octokit, payload, repo: "catalyst" }) };
}

test("status: pending without a label gets the suggested label text and loses fp", async () => {
  const t = setup();
  await t.dispatch("status", t.context(statusPayload()));
  assert.deepEqual(t.calls("rest.repos.createCommitStatus"), [{
    owner: "acme", repo: "catalyst", sha: SHA, context: "UI Review", state: "pending",
    description: 'Add "splendid" label — 3 modified', target_url: URL(),
  }]);
});

test("status: success without a label is left alone", async () => {
  const t = setup();
  await t.dispatch("status", t.context(statusPayload({ state: "success" })));
  assert.equal(t.calls("rest.repos.createCommitStatus").length, 0);
});

test("status: the app's own rewrites (no fp) and other contexts are ignored", async () => {
  const t = setup();
  await t.dispatch("status", t.context(statusPayload({ fp: null })));
  await t.dispatch("status", t.context(statusPayload({ context: "AI Review" })));
  assert.equal(t.octokit.calls.length, 0);
});

test("status: no open PR at this head means nothing happens", async () => {
  const t = setup({ prs: [{ ...pr(), state: "closed" }, { ...pr(), head: { sha: "other" } }] });
  await t.dispatch("status", t.context(statusPayload()));
  assert.equal(t.calls("rest.repos.createCommitStatus").length, 0);
});

test("status: a matching stamp carries the approval forward", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
  });
  await t.dispatch("status", t.context(statusPayload()));
  assert.deepEqual(t.calls("rest.repos.createCommitStatus"), [{
    owner: "acme", repo: "catalyst", sha: SHA, context: "UI Review", state: "success",
    description: "Approved by Reece Como — 3 modified", target_url: URL(),
  }]);
  assert.equal(t.calls("rest.issues.removeLabel").length, 0);
});

test("status: a matching stamp on an already-successful status does nothing", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
  });
  await t.dispatch("status", t.context(statusPayload({ state: "success" })));
  assert.equal(t.calls("rest.repos.createCommitStatus").length, 0);
});

test("status: a different fingerprint clears every label and stamp and reverts approved suites", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime", "gorgeous", "bug"] })],
    comments: [
      toolComment(1, "11111111", { stampFp: "cb4f8904" }),
      toolComment(2, "22222222", { stampFp: "22222222", suite: "admin" }),
      { id: 3, body: "unrelated comment" },
    ],
    statuses: [
      { context: "UI Review", state: "pending", description: "3 modified", target_url: URL("11111111") },
      { context: "UI Review (admin)", state: "success", description: "Approved by Reece Como — 1 added", target_url: URL() },
      { context: "AI Review", state: "success", description: "Reviewed", target_url: "https://x" },
    ],
  });
  await t.dispatch("status", t.context(statusPayload({ fp: "11111111" })));

  assert.deepEqual(t.calls("rest.issues.removeLabel").map((a) => a.name), ["sublime", "gorgeous"]);
  assert.deepEqual(
    t.calls("rest.issues.updateComment").map((a) => [a.comment_id, a.body.includes("ui-approved")]),
    [[1, false], [2, false]],
  );
  assert.deepEqual(t.calls("rest.repos.createCommitStatus").map((a) => [a.context, a.state, a.description]), [
    ["UI Review (admin)", "pending", 'Add "splendid" label — 1 added'],
    ["UI Review", "pending", 'Add "splendid" label — 3 modified'],
  ]);
});

test("status: a label with no stamp at all is cleared", async () => {
  const t = setup({ prs: [pr({ labels: ["stunning"] })], comments: [toolComment(1, "cb4f8904")] });
  await t.dispatch("status", t.context(statusPayload()));
  assert.deepEqual(t.calls("rest.issues.removeLabel").map((a) => a.name), ["stunning"]);
  assert.deepEqual(t.calls("rest.repos.createCommitStatus").map((a) => a.description), ['Add "splendid" label — 3 modified']);
});

const labelPayload = (name, { labels = [name], type = "User" } = {}) => ({
  label: { name }, pull_request: pr({ labels }), sender: { login: "reececomo", type },
});

test("pull_request.labeled: stamps every tool comment and flips the pending statuses", async () => {
  const t = setup({
    comments: [toolComment(1, "cb4f8904"), toolComment(2, "1a2b3c4d", { suite: "admin" }), { id: 3, body: "hi" }],
    statuses: [
      { context: "UI Review", state: "pending", description: 'Add "splendid" label — 3 modified', target_url: URL() },
      { context: "UI Review (admin)", state: "pending", description: "1 added", target_url: URL("1a2b3c4d") },
      { context: "UI Review (stale)", state: "pending", description: "9 added", target_url: URL("99999999") },
      { context: "AI Review", state: "pending", description: "Requested", target_url: "https://x" },
    ],
  });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("gorgeous")));

  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => [a.comment_id, a.body.split("\n").at(-1)]), [
    [1, STAMP("cb4f8904")],
    [2, STAMP("1a2b3c4d")],
  ]);
  assert.deepEqual(t.calls("rest.repos.createCommitStatus").map((a) => [a.context, a.state, a.description, a.target_url]), [
    ["UI Review", "success", "Approved by Reece Como — 3 modified", URL()],
    ["UI Review (admin)", "success", "Approved by Reece Como — 1 added", URL()],
  ]);
});

test("pull_request.labeled: falls back to the login without a display name", async () => {
  const t = setup({
    comments: [toolComment(1, "cb4f8904")],
    statuses: [{ context: "UI Review", state: "pending", description: "3 modified", target_url: URL() }],
    user: { name: null },
  });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("sublime")));
  assert.equal(t.calls("rest.repos.createCommitStatus")[0].description, "Approved by reececomo — 3 modified");
  assert.ok(t.calls("rest.issues.updateComment")[0].body.endsWith(STAMP("cb4f8904", "reececomo")));
});

test("pull_request.labeled: before the tool has commented, the label is removed", async () => {
  const t = setup({ comments: [{ id: 3, body: "hi" }] });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("sublime")));
  assert.deepEqual(t.calls("rest.issues.removeLabel").map((a) => a.name), ["sublime"]);
  assert.equal(t.calls("rest.repos.createCommitStatus").length, 0);
});

test("pull_request.labeled: other labels are ignored", async () => {
  const t = setup();
  await t.dispatch("pull_request.labeled", t.context(labelPayload("bug")));
  assert.equal(t.octokit.calls.length, 0);
});

test("pull_request.unlabeled: a human removing the last approval label reverts and unstamps", async () => {
  const t = setup({
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: [{ context: "UI Review", state: "success", description: "Approved by Reece Como — 3 modified", target_url: URL() }],
  });
  await t.dispatch("pull_request.unlabeled", t.context(labelPayload("sublime", { labels: [] })));
  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => a.body.includes("ui-approved")), [false]);
  assert.deepEqual(t.calls("rest.repos.createCommitStatus").map((a) => [a.state, a.description]), [
    ["pending", 'Add "splendid" label — 3 modified'],
  ]);
});

test("pull_request.unlabeled: ignored when another approval label remains or the app did it", async () => {
  const t = setup();
  await t.dispatch("pull_request.unlabeled", t.context(labelPayload("sublime", { labels: ["gorgeous"] })));
  await t.dispatch("pull_request.unlabeled", t.context(labelPayload("sublime", { labels: [], type: "Bot" })));
  assert.equal(t.octokit.calls.length, 0);
});
