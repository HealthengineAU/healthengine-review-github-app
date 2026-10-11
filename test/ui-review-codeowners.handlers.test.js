import { test } from "node:test";
import assert from "node:assert/strict";

import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";
import { register } from "../lib/ui-review-approvals.js";

const SHA = "3897e0b2a142230837e29e68dc4b18a8d318166e";
const VIEWER = (fp) => `https://visreg.he0.io/?r=catalyst&b=feature-x${fp ? `&fp=${fp}` : ""}`;
const COMMENT_URL = "https://github.com/acme/catalyst/pull/57#issuecomment-1";
const TEAMS = { pingu: ["dev", "penny"], jarvis: ["jill"], marketplace: ["mia"], "patient-accounts": ["pat"] };

const ownersTag = (entries) => `<!-- ui-owners${entries.map((e) => ` ${e}`).join("")} -->`;
const comment = (entries, { fp, extra = [] } = {}) => ({
  id: 1,
  html_url: COMMENT_URL,
  body: ["<!-- found-pixel-comment -->", ...(fp ? [`<!-- ui-review fp=${fp} -->`] : []), ownersTag(entries), ...extra, "## 📘 UI Review"].join("\n"),
});
const pr = ({ draft = false, state = "open", author = "dev" } = {}) => ({ number: 57, draft, state, user: { login: author }, head: { sha: SHA } });
const toolStatus = ({ state = "success", fp } = {}) => ({ context: "UI Review", state, description: "3 modified", target_url: VIEWER(fp) });
const approval = (login, id = 1) => ({ id, state: "APPROVED", user: { login } });

function setup({ current = pr(), comments = [], timeline = [], reviews = [], statuses = [toolStatus()] } = {}) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.repos.listPullRequestsAssociatedWithCommit": { data: [current] },
    "paginate:rest.repos.listCommitStatusesForRef": statuses,
    "paginate:rest.issues.listComments": comments,
    "paginate:rest.issues.listEventsForTimeline": timeline,
    "paginate:rest.pulls.listReviews": reviews,
    "paginate:rest.teams.listMembersInOrg": ({ team_slug }) => (TEAMS[team_slug] ?? []).map((login) => ({ login })),
  });
  const calls = (method) => octokit.calls.filter((c) => c.method === method).map((c) => c.args);
  const context = (payload) => makeContext({ octokit, payload, owner: "acme", repo: "catalyst" });
  return {
    octokit,
    invited: () => calls("rest.pulls.requestReviewers").map(({ reviewers, team_reviewers }) => ({ reviewers, team_reviewers })),
    posted: () => calls("rest.repos.createCommitStatus").map((a) => [a.state, a.description, a.target_url]),
    onStatus: () => dispatch("status", context({ ...statuses[0], sha: SHA, repository: { name: "catalyst" } })),
    onReady: () => dispatch("pull_request.ready_for_review", context({ pull_request: current })),
    onReview: () => dispatch("pull_request_review.submitted", context({ pull_request: current })),
  };
}

test("invites other teams' owners and holds UI Review until they approve", async () => {
  const t = setup({ comments: [comment(["@acme/jarvis", "@acme/pingu"])] });
  await t.onStatus();
  assert.deepEqual(t.invited(), [{ reviewers: [], team_reviewers: ["jarvis"] }]);
  assert.deepEqual(t.posted(), [["pending", "Needs Jarvis code owner approval - 3 modified", COMMENT_URL]]);
});

test("drafts are held but only invited once ready for review", async () => {
  const draft = setup({ current: pr({ draft: true }), comments: [comment(["@acme/jarvis"])] });
  await draft.onStatus();
  assert.deepEqual(draft.invited(), []);
  assert.deepEqual(draft.posted(), [["pending", "Needs Jarvis code owner approval - 3 modified", COMMENT_URL]]);

  const ready = setup({ comments: [comment(["@acme/jarvis"])] });
  await ready.onReady();
  assert.deepEqual(ready.invited(), [{ reviewers: [], team_reviewers: ["jarvis"] }]);
});

test("a required review and outstanding code owners show together", async () => {
  const stamp = '<!-- ui-approved fp=cb4f8904 by=reececomo name="Reece Como" -->';
  const t = setup({
    comments: [comment(["@acme/jarvis"], { fp: "cb4f8904", extra: ["> [!Warning]", "> - [x] ~Changes reviewed~ - Reviewed by @reececomo", stamp] })],
    statuses: [toolStatus({ state: "pending", fp: "cb4f8904" })],
  });
  await t.onStatus();
  assert.deepEqual(t.posted(), [["pending", "Needs Jarvis code owner approval, Reviewed by Reece Como - 3 modified", COMMENT_URL]]);
});

test("a PR approval from any member, at any point, clears the owner", async () => {
  const t = setup({
    comments: [comment(["@acme/jarvis", "@acme/marketplace,@acme/patient-accounts"])],
    reviews: [approval("Jill", 7), { id: 8, state: "DISMISSED", user: { login: "pat" } }],
    timeline: [
      { event: "review_requested", requested_team: { slug: "jarvis" } },
      { event: "review_requested", requested_team: { slug: "marketplace" } },
      { event: "review_requested", requested_team: { slug: "patient-accounts" } },
      { event: "review_dismissed", dismissed_review: { state: "approved", review_id: 8 } },
    ],
  });
  await t.onReview();
  assert.deepEqual(t.invited(), []);
  assert.deepEqual(t.posted(), [["success", "✓ Approved by Jarvis, Marketplace/Patient Accounts - 3 modified", VIEWER()]]);
});

test("comments and approvals from outside the team don't count", async () => {
  const t = setup({
    comments: [comment(["@acme/jarvis", "@reececomo"])],
    reviews: [{ id: 1, state: "COMMENTED", user: { login: "jill" } }, approval("mia", 2)],
    timeline: [{ event: "review_requested", requested_team: { slug: "jarvis" } }],
  });
  await t.onReview();
  assert.deepEqual(t.invited(), [{ reviewers: ["reececomo"], team_reviewers: [] }]);
  assert.deepEqual(t.posted(), [["pending", "Needs Jarvis, reececomo code owner approval - 3 modified", COMMENT_URL]]);
});

test("the author's own teams and the author are excluded, leaving found-pixel's status alone", async () => {
  const t = setup({ current: pr({ author: "penny" }), comments: [comment(["@acme/pingu", "@penny", "@other/team"])] });
  await t.onStatus();
  assert.deepEqual(t.invited(), []);
  assert.deepEqual(t.posted(), []);
});

test("never re-invites an owner asked before, even if removed, but still waits for them", async () => {
  const t = setup({
    comments: [comment(["@acme/jarvis"])],
    timeline: [
      { event: "review_requested", requested_team: { slug: "Jarvis" } },
      { event: "review_request_removed", requested_team: { slug: "jarvis" } },
    ],
  });
  await t.onStatus();
  assert.deepEqual(t.invited(), []);
  assert.deepEqual(t.posted(), [["pending", "Needs Jarvis code owner approval - 3 modified", COMMENT_URL]]);
});

test("PR events without found-pixel's owners tag stop after reading the comments", async () => {
  const t = setup({ comments: [{ id: 1, body: "<!-- found-pixel-comment -->\n## 📘 UI Review" }] });
  await t.onReview();
  assert.deepEqual(t.octokit.calls.map((c) => c.method), ["paginate:rest.issues.listComments"]);
});

test("closed PRs are left alone", async () => {
  const t = setup({ current: pr({ state: "closed" }), comments: [comment(["@acme/jarvis"])] });
  await t.onReview();
  assert.equal(t.octokit.calls.length, 0);
});
