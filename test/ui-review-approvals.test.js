import { test } from "node:test";
import assert from "node:assert/strict";

const {
  approvalOf,
  approve,
  fingerprintOf,
  isUiReviewStatus,
  parseStamp,
  prompt,
  renderStamp,
  reviewState,
  unapprove,
  uiReviewStatus,
} = await import("../lib/ui-review-approvals.js");

const LINES = {
  prompt: "> - [ ] **Changes acknowledged** - ✅ Check this box to confirm these look correct",
  ticked: "> - [x] **Changes acknowledged** - ✅ Check this box to confirm these look correct",
  approved: "> - [x] ~Changes acknowledged~ - Acknowledged by @reececomo",
  unticked: "> - [ ] ~Changes acknowledged~ - Acknowledged by @reececomo",
};
const raw = (fp) => `<!-- found-pixel-comment -->\n<!-- ui-review fp=${fp} -->\n## 📘 UI Review`;
const body = (fp, line = "prompt") =>
  `${raw(fp)}\n\n<h2></h2>\n\n> [!Warning]\n${LINES[line]}\n`;
const STAMP = (fp) => `<!-- ui-approved fp=${fp} by=reececomo name="Reece Como" -->`;

test("isUiReviewStatus matches the bare and suited contexts only", () => {
  assert.ok(isUiReviewStatus("UI Review"));
  assert.ok(isUiReviewStatus("UI Review (admin)"));
  assert.ok(!isUiReviewStatus("AI Review"));
  assert.ok(!isUiReviewStatus("UI Review extra"));
  assert.ok(!isUiReviewStatus(undefined));
});

test("fingerprintOf reads the fp param", () => {
  assert.equal(fingerprintOf("https://visreg.he0.io/?r=catalyst&b=feature-x&fp=cb4f8904"), "cb4f8904");
  assert.equal(fingerprintOf("https://visreg.he0.io/?r=catalyst"), null);
  assert.equal(fingerprintOf("not a url"), null);
});

test("reviewState reads the fingerprint, checkbox and its label in any form", () => {
  const state = (line) => reviewState(body("cb4f8904", line));
  assert.deepEqual(state("prompt"), { fp: "cb4f8904", ticked: false, label: "**Changes acknowledged** - ✅ Check this box to confirm these look correct" });
  assert.deepEqual(state("ticked"), { ...state("prompt"), ticked: true });
  assert.deepEqual(state("approved"), { fp: "cb4f8904", ticked: true, label: "~Changes acknowledged~ - Acknowledged by @reececomo" });
  assert.deepEqual(state("unticked"), { ...state("approved"), ticked: false });
  assert.equal(reviewState(body("cb4f8904").replace("[ ]", "[X]")).ticked, true);
  assert.equal(reviewState(raw("cb4f8904")), null);
  assert.equal(reviewState(LINES.ticked), null);
  assert.equal(reviewState(undefined), null);
});

test("prompt adds the checkbox under the fingerprint and drops a stale stamp", () => {
  assert.equal(prompt(raw("cb4f8904")), body("cb4f8904"));
  assert.equal(prompt(`${raw("cb4f8904")}\n${STAMP("1a2b3c4d")}`), body("cb4f8904"));
  assert.equal(prompt(body("cb4f8904", "ticked")), body("cb4f8904", "ticked"));
});

test("approve rewrites or adds the approved line and stamps; unapprove reverts", () => {
  const stamp = { fp: "cb4f8904", by: "reececomo", name: 'Reece "RC" <Como> $&' };
  const approved = approve(body("cb4f8904", "ticked"), stamp);
  assert.equal(approved, `${body("cb4f8904", "approved")}\n<!-- ui-approved fp=cb4f8904 by=reececomo name="Reece RC Como $&" -->`);
  const carried = approve(`${raw("cb4f8904")}\n${STAMP("cb4f8904")}`, stamp);
  assert.equal(reviewState(carried).label, "~Changes acknowledged~ - Acknowledged by @reececomo");
  assert.equal(carried.match(/ui-approved/g).length, 1);

  const restamped = approve(approved, { fp: "1a2b3c4d", by: "reececomo", name: "Reece" });
  assert.equal(restamped.match(/ui-approved/g).length, 1);
  assert.equal(parseStamp(restamped).fp, "1a2b3c4d");

  assert.equal(unapprove(approved.replace(LINES.approved, LINES.unticked)), body("cb4f8904"));
});

test("approvalOf needs a stamp for the comment's fingerprint", () => {
  const approval = { fp: "cb4f8904", by: "reececomo", name: "Reece Como" };
  assert.deepEqual(approvalOf(`${body("cb4f8904", "approved")}\n${STAMP("cb4f8904")}`), approval);
  assert.deepEqual(approvalOf(`${body("cb4f8904")}\n${STAMP("cb4f8904")}`), approval);
  assert.deepEqual(approvalOf(`${raw("cb4f8904")}\n${STAMP("cb4f8904")}`), approval);
  assert.equal(approvalOf(`${raw("1a2b3c4d")}\n${STAMP("cb4f8904")}`), null);
  assert.equal(approvalOf(body("cb4f8904", "ticked")), null);
});

test("parseStamp tolerates a missing name", () => {
  assert.deepEqual(parseStamp("x <!-- ui-approved fp=1 by=bob --> y"), { fp: "1", by: "bob", name: "bob" });
});

test("uiReviewStatus leads with outstanding code owners and ends with the acknowledgement", () => {
  const tool = { state: "pending", description: "3 modified", target_url: "https://v/?fp=cb4f8904" };
  const status = (opts) => uiReviewStatus(tool, opts);
  const reece = { approval: { by: "reececomo", name: "Reece Como" } };
  const jarvis = [["@acme/jarvis"]];

  assert.deepEqual(status({ review: { approval: null } }), { state: "pending", description: "3 modified - ⏳ Changes awaiting acknowledgement", target_url: tool.target_url });
  assert.deepEqual(status({ review: reece }), { state: "success", description: "3 modified - ✅ Changes acknowledged", target_url: tool.target_url });
  assert.equal(status({ review: reece, owners: { pending: jarvis, approved: [] } }).description, "⏳ Awaiting PR approvals: Jarvis - 3 modified - ✅ Changes acknowledged");
  assert.equal(
    status({ review: { approval: null }, owners: { pending: [["@acme/jarvis"], ["@reececomo"]], approved: [] } }).description,
    "⏳ Awaiting PR approvals: Jarvis, reececomo - 3 modified - ⏳ Changes awaiting acknowledgement",
  );
  assert.equal(
    status({ review: { approval: null }, owners: { pending: [["@acme/marketplace"], ["@acme/marketplace", "@acme/pingu"], ["@acme/Pingu"]], approved: [] } }).description,
    "⏳ Awaiting PR approvals: Marketplace, Pingu - 3 modified - ⏳ Changes awaiting acknowledgement",
  );
  assert.equal(
    status({ review: reece, owners: { pending: [["@acme/marketplace", "@acme/pingu"]], approved: [["@acme/pingu"], ["@acme/pingu", "@acme/jarvis"]] } }).description,
    "⏳ Awaiting PR approvals: Marketplace/Pingu - 3 modified - ✅ Changes acknowledged",
  );
  assert.deepEqual(status({ review: reece, owners: { pending: [], approved: [["@acme/marketplace", "@acme/patient-accounts"]] } }), {
    state: "success",
    description: "3 modified - ✅ Changes acknowledged",
    target_url: tool.target_url,
  });

  const done = { state: "success", description: "3 modified", target_url: "https://v" };
  assert.deepEqual(uiReviewStatus(done, { review: null, owners: { pending: jarvis, approved: [] } }), {
    state: "pending", description: "⏳ Awaiting PR approvals: Jarvis - 3 modified", target_url: "https://v",
  });
  assert.deepEqual(uiReviewStatus(done, { review: null, owners: { pending: [], approved: jarvis } }), done);
  assert.deepEqual(uiReviewStatus(done, { review: null, owners: null }), done);
});

test("uiReviewStatus stays within 140 chars", () => {
  const tool = { state: "pending", description: "B".repeat(200), target_url: "https://v" };
  const long = uiReviewStatus(tool, { review: { approval: null }, owners: { pending: [["@acme/jarvis"]], approved: [] } }).description;
  assert.equal(long.length, 140);
  assert.ok(long.startsWith("⏳ Awaiting PR approvals: Jarvis - BBB"));
  assert.ok(long.endsWith("B… - ⏳ Changes awaiting acknowledgement"));

  const owners = { pending: Array.from({ length: 20 }, (_, i) => [`@acme/team-${i}`]), approved: [] };
  const crowded = uiReviewStatus(tool, { review: { approval: { by: "x" } }, owners }).description;
  assert.equal(crowded.length, 140);
  assert.ok(crowded.startsWith("⏳ Awaiting PR approvals: Team 0, "));
  assert.ok(crowded.endsWith("… - ✅ Changes acknowledged"));
});

test("uiReviewStatus avoids 4-byte characters, which GitHub rejects in status descriptions", () => {
  const tool = { state: "pending", description: "3 modified", target_url: "https://v" };
  const pending = { pending: [["@acme/jarvis"]], approved: [] };
  for (const review of [{ approval: null }, { approval: { by: "x" } }]) {
    assert.doesNotMatch(uiReviewStatus(tool, { review, owners: pending }).description, /[\u{10000}-\u{10FFFF}]/u);
  }
});

test("withOwnersStatus tabulates owners with filtered shortcuts under the checkbox", async () => {
  const { withOwnersStatus } = await import("../lib/ui-review-approvals.js");
  const review = "https://visreg.he0.io/?r=unicron&b=NOOT-1";
  const story = "https://code.he0.io/unicron/storybook/NOOT-1/";
  const base = `${body("cb4f8904", "approved")}`.replace("## 📘 UI Review", `## 📘 UI Review\n\nDetected 2 changes [↗ Review](${review})\n\n[Story](${story}?path=/story/a--b)`);
  const owners = { rows: [{ entry: ["@org/pingu"], by: null }, { entry: ["@org/marketplace"], by: "nstreet" }] };
  const out = withOwnersStatus(base, owners);
  assert.ok(out.startsWith(base.trimEnd()));
  assert.ok(out.endsWith([
    "<!-- ui-owners-status -->",
    "| | Affected owners | Shortcuts |",
    "|:-:|---|---|",
    `| 🟡 | **Pingu** · _PR approval needed_ | [↗ Review](${review}&owner=%40org%2Fpingu&view=gallery) · [Storybook](${story}?tags=%40org%2Fpingu&statuses=modified;new) |`,
    `| ✅ | ~Marketplace~ · _PR approved by @nstreet_ | [↗ Review](${review}&owner=%40org%2Fmarketplace&view=gallery) · [Storybook](${story}?tags=%40org%2Fmarketplace&statuses=modified;new) |`,
    "",
  ].join("\n")));
  assert.equal(withOwnersStatus(out, owners), out);
  assert.equal(withOwnersStatus(out, null), base.trimEnd());
  assert.equal(withOwnersStatus(raw("cb4f8904"), owners).match(/<h2><\/h2>/g).length, 1);
  const edited = `${out.replaceAll("\n", "\r\n")}\n${STAMP("cb4f8904")}\n${out.slice(base.trimEnd().length)}`;
  const healed = withOwnersStatus(edited, owners);
  assert.equal(healed.match(/<!-- ui-owners-status -->/g).length, 1);
  assert.ok(healed.includes(STAMP("cb4f8904")));
});
