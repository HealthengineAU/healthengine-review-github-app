import { test } from "node:test";
import assert from "node:assert/strict";

import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

process.env.WEBHOOK_SECRET = "test-secret";
const { register, signStamp } = await import("../lib/ui-review-approvals.js");

const SHA = "3897e0b2a142230837e29e68dc4b18a8d318166e";
const URL = (fp) => `https://visreg.he0.io/?r=catalyst&b=feature-x${fp ? `&fp=${fp}` : ""}`;
const STAMP = (id, fp, name = "Reece Como", sig = signStamp(id, fp)) =>
  `<!-- ui-approved by=reececomo name="${name}" fp=${fp} sig=${sig} -->`;

const toolComment = (id, fp, { stampFp, forged = false, suite } = {}) => ({
  id,
  body: [
    suite ? `<!-- visreg-comment:${suite} -->` : "<!-- found-pixel-comment -->",
    `<!-- ui-review fp=${fp} -->`,
    "### 📘 UI Review",
    ...(stampFp ? [STAMP(id, stampFp, "Reece Como", forged ? "0000000000000000" : undefined)] : []),
  ].join("\n"),
});

const pr = ({ labels = [], number = 57, state = "open" } = {}) => ({
  number,
  state,
  head: { sha: SHA },
  labels: labels.map((name) => ({ name })),
});

const status = ({ context = "UI Review", state = "pending", description = "3 modified", fp = "cb4f8904" } = {}) => ({
  context, state, description, target_url: URL(fp),
});

const statusPayload = (overrides = {}) => ({ ...status(overrides), sha: SHA, repository: { name: "catalyst" } });

function setup({ prs = [pr()], current, comments = [], statuses, user = { name: "Reece Como" } } = {}) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.repos.listPullRequestsAssociatedWithCommit": { data: prs },
    "rest.pulls.get": { data: current ?? prs[0] },
    "paginate:rest.issues.listComments": comments,
    "paginate:rest.repos.listCommitStatusesForRef": statuses,
    "rest.users.getByUsername": { data: user },
  });
  const calls = (method) => octokit.calls.filter((c) => c.method === method).map((c) => c.args);
  const posted = () => calls("rest.repos.createCommitStatus").map((a) => [a.context, a.state, a.description, a.target_url]);
  return { dispatch, octokit, calls, posted, context: (payload) => makeContext({ octokit, payload, repo: "catalyst" }) };
}

// The event is the latest status for its context unless a test says otherwise.
const onStatus = (t, overrides = {}) => t.dispatch("status", t.context(statusPayload(overrides)));
const withEvent = (overrides = {}, others = []) => [status(overrides), ...others];

test("status: pending without a label gets the suggested label text and keeps fp", async () => {
  const t = setup({ statuses: withEvent() });
  await onStatus(t);
  assert.deepEqual(t.posted(), [["UI Review", "pending", 'Label as "splendid" to approve - 3 modified', URL("cb4f8904")]]);
  assert.equal(t.calls("rest.repos.createCommitStatus")[0].sha, SHA);
});

test("status: success without a label is left alone", async () => {
  const t = setup({ statuses: withEvent({ state: "success" }) });
  await onStatus(t, { state: "success" });
  assert.equal(t.posted().length, 0);
});

test("status: the app's own rewrites, statuses without fp, and other contexts are ignored", async () => {
  const t = setup({ statuses: withEvent() });
  await onStatus(t, { description: 'Label as "splendid" to approve - 3 modified' });
  await onStatus(t, { description: "✓ Reviewed by Reece Como - 3 modified", state: "success" });
  await onStatus(t, { fp: null });
  await onStatus(t, { context: "AI Review" });
  assert.equal(t.octokit.calls.length, 0);
});

test("status: a stale event (the context has moved on) is ignored", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: [status({ state: "error", description: "storybook-diff could not read this Storybook build", fp: null })],
  });
  await onStatus(t);
  assert.equal(t.posted().length, 0);
  assert.equal(t.calls("rest.issues.removeLabel").length, 0);
});

test("status: no open PR at this head means nothing happens", async () => {
  const t = setup({ prs: [pr({ state: "closed" }), { ...pr(), head: { sha: "other" } }], statuses: withEvent() });
  await onStatus(t);
  assert.equal(t.posted().length, 0);
});

test("status: a matching signed stamp carries the approval forward", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: withEvent(),
  });
  await onStatus(t);
  assert.deepEqual(t.posted(), [["UI Review", "success", "✓ Reviewed by Reece Como - 3 modified", URL("cb4f8904")]]);
  assert.equal(t.calls("rest.issues.removeLabel").length, 0);
});

test("status: a matching stamp on an already-successful status does nothing", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: withEvent({ state: "success" }),
  });
  await onStatus(t, { state: "success" });
  assert.equal(t.posted().length, 0);
});

test("status: a forged stamp (bad signature) does not approve and clears the label", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904", forged: true })],
    statuses: withEvent(),
  });
  await onStatus(t);
  assert.deepEqual(t.calls("rest.issues.removeLabel").map((a) => a.name), ["sublime"]);
  assert.deepEqual(t.posted(), [["UI Review", "pending", 'Label as "splendid" to approve - 3 modified', URL("cb4f8904")]]);
});

test("status: a different fingerprint clears every label and stamp and reverts approved suites", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime", "gorgeous", "bug"] })],
    comments: [
      toolComment(1, "11111111", { stampFp: "cb4f8904" }),
      toolComment(2, "22222222", { stampFp: "22222222", suite: "admin" }),
      { id: 3, body: "unrelated comment" },
    ],
    statuses: withEvent({ fp: "11111111" }, [
      status({ context: "UI Review (admin)", state: "success", description: "✓ Reviewed by Reece Como - 1 added", fp: "22222222" }),
      status({ context: "AI Review", state: "success", description: "Reviewed", fp: null }),
    ]),
  });
  await onStatus(t, { fp: "11111111" });

  assert.deepEqual(t.calls("rest.issues.removeLabel").map((a) => a.name), ["sublime", "gorgeous"]);
  assert.deepEqual(
    t.calls("rest.issues.updateComment").map((a) => [a.comment_id, a.body.includes("ui-approved")]),
    [[1, false], [2, false]],
  );
  assert.deepEqual(t.posted(), [
    ["UI Review (admin)", "pending", 'Label as "splendid" to approve - 1 added', URL("22222222")],
    ["UI Review", "pending", 'Label as "splendid" to approve - 3 modified', URL("11111111")],
  ]);
});

test("status: only the newest status per context counts", async () => {
  const t = setup({
    prs: [pr({ labels: ["sublime"] })],
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: [status(), status({ state: "error", description: "older", fp: null })],
  });
  await onStatus(t);
  assert.equal(t.posted().length, 1);
});

const labelPayload = (name, { labels = [name], type = "User" } = {}) => ({
  label: { name }, pull_request: pr({ labels }), sender: { login: "reececomo", type },
});

test("pull_request.labeled: stamps every tool comment and flips the pending statuses whose fp it covers", async () => {
  const t = setup({
    current: pr({ labels: ["gorgeous"] }),
    comments: [toolComment(1, "cb4f8904"), toolComment(2, "1a2b3c4d", { suite: "admin" }), { id: 3, body: "hi" }],
    statuses: [
      status({ description: 'Label as "splendid" to approve - 3 modified' }),
      status({ context: "UI Review (admin)", description: "1 added", fp: "1a2b3c4d" }),
      status({ context: "UI Review (stale)", description: 'Label as "splendid" to approve - 9 added', fp: "99999999" }),
      status({ context: "UI Review (done)", state: "success", description: "No changes", fp: null }),
      status({ context: "AI Review", description: "Requested", fp: null }),
    ],
  });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("gorgeous")));

  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => [a.comment_id, a.body.split("\n").at(-1)]), [
    [1, STAMP(1, "cb4f8904")],
    [2, STAMP(2, "1a2b3c4d")],
  ]);
  assert.deepEqual(t.posted(), [
    ["UI Review", "success", "✓ Reviewed by Reece Como - 3 modified", URL("cb4f8904")],
    ["UI Review (admin)", "success", "✓ Reviewed by Reece Como - 1 added", URL("1a2b3c4d")],
  ]);
});

test("pull_request.labeled: display names are sanitised and fall back to the login", async () => {
  const base = {
    comments: [toolComment(1, "cb4f8904")],
    statuses: [status()],
  };
  const t = setup({ ...base, current: pr({ labels: ["sublime"] }), user: { name: null } });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("sublime")));
  assert.equal(t.posted()[0][2], "✓ Reviewed by reececomo - 3 modified");
  assert.ok(t.calls("rest.issues.updateComment")[0].body.endsWith(STAMP(1, "cb4f8904", "reececomo")));

  const u = setup({ ...base, current: pr({ labels: ["sublime"] }), user: { name: "Alice <alice@example.com>" } });
  await u.dispatch("pull_request.labeled", u.context(labelPayload("sublime")));
  assert.equal(u.posted()[0][2], "✓ Reviewed by Alice alice@example.com - 3 modified");
  assert.ok(u.calls("rest.issues.updateComment")[0].body.endsWith(STAMP(1, "cb4f8904", "Alice alice@example.com")));
});

test("pull_request.labeled: a replayed event for a label that is gone does nothing", async () => {
  const t = setup({ current: pr({ labels: [] }), comments: [toolComment(1, "cb4f8904")], statuses: [status()] });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("sublime")));
  assert.deepEqual(t.octokit.calls.map((c) => c.method), ["rest.pulls.get"]);
});

test("pull_request.labeled: nothing happens without a fingerprinted tool comment", async () => {
  const t = setup({ current: pr({ labels: ["sublime"] }), comments: [{ id: 3, body: "hi" }, { id: 4, body: "<!-- found-pixel-comment -->\n### UI Review" }] });
  await t.dispatch("pull_request.labeled", t.context(labelPayload("sublime")));
  assert.deepEqual(t.octokit.calls.map((c) => c.method), ["rest.pulls.get", "paginate:rest.issues.listComments"]);
});

test("pull_request.labeled: other labels are ignored", async () => {
  const t = setup();
  await t.dispatch("pull_request.labeled", t.context(labelPayload("bug")));
  assert.equal(t.octokit.calls.length, 0);
});

test("pull_request.unlabeled: a human removing the last approval label reverts and unstamps", async () => {
  const t = setup({
    comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: [status({ state: "success", description: "✓ Reviewed by Reece Como - 3 modified" })],
  });
  await t.dispatch("pull_request.unlabeled", t.context(labelPayload("sublime", { labels: [] })));
  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => a.body.includes("ui-approved")), [false]);
  assert.deepEqual(t.posted(), [["UI Review", "pending", 'Label as "splendid" to approve - 3 modified', URL("cb4f8904")]]);
});

test("pull_request.unlabeled: ignored when another approval label remains or the app did it", async () => {
  const t = setup();
  await t.dispatch("pull_request.unlabeled", t.context(labelPayload("sublime", { labels: ["gorgeous"] })));
  await t.dispatch("pull_request.unlabeled", t.context(labelPayload("sublime", { labels: [], type: "Bot" })));
  assert.equal(t.octokit.calls.length, 0);
});
