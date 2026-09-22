import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyMention } from "../lib/dusty-slack-proxy.js";
import { LABEL, STATUS } from "../lib/incident/constants.js";
import {
  createdBlocks,
  decodeRef,
  unescapeSlackText,
  prefillSummary,
  draftReportPrompt,
  encodeRef,
  incidentModal,
  statusChannelText,
  statusThreadBlocks,
  summaryFromView,
  thanksBlocks,
  threadBlocks,
  triageText,
} from "../lib/incident/blocks.js";
import {
  browseUrl,
  jiraClient,
  findAccountId,
  incidentDescription,
  jiraTimestamp,
  transitionTo,
} from "../lib/incident/jira.js";

test("jiraTimestamp emits Perth time with a colon-less offset and millis", () => {
  assert.equal(jiraTimestamp(new Date("2026-09-21T08:12:53.307Z")), "2026-09-21T16:12:53.307+0800");
});

test("jiraTimestamp rolls the date forward across the UTC day boundary", () => {
  assert.equal(jiraTimestamp(new Date("2026-09-21T23:00:00.000Z")), "2026-09-22T07:00:00.000+0800");
});

test("browseUrl tolerates a trailing slash on the base url", () => {
  assert.equal(browseUrl("https://hejira.atlassian.net/", "INCY-1"), "https://hejira.atlassian.net/browse/INCY-1");
});

test("encodeRef/decodeRef round-trip the coordinates a button acts on", () => {
  const ref = { key: "INCY-1", channel: "C1", thread: "111.1", reporter: "U9" };
  assert.deepEqual(decodeRef(encodeRef(ref)), ref);
});

test("decodeRef rejects junk and incomplete refs rather than throwing", () => {
  assert.equal(decodeRef("not json"), null);
  assert.equal(decodeRef(undefined), null);
  assert.equal(decodeRef(JSON.stringify({ k: "INCY-1" })), null);
});

test("summaryFromView pulls the trimmed summary out of the modal state", () => {
  const view = { state: { values: { summary: { value: { value: "  Bookings failing  " } } } } };
  assert.equal(summaryFromView(view), "Bookings failing");
});

test("summaryFromView returns empty string when the field is missing", () => {
  assert.equal(summaryFromView({}), "");
});

test("incidentModal asks exactly one question", () => {
  const modal = incidentModal();
  assert.equal(modal.callback_id, "incident_create");
  assert.equal(modal.blocks.filter((b) => b.type === "input").length, 1);
});

test("triageText links the issue with Slack mrkdwn, not markdown", () => {
  const text = triageText({ key: "INCY-1", url: "https://j/browse/INCY-1", summary: "Bookings failing" });
  assert.equal(text, "*Incident <https://j/browse/INCY-1|INCY-1>* - Bookings failing - thread :thread:");
  assert.ok(!text.includes("]("));
});

// Resolving is the step after mitigating, not an alternative to it, so the
// opening reply offers one button and no shortcut past it.
test("threadBlocks offers only a green Mark as mitigated, carrying the ref", () => {
  const ref = encodeRef({ key: "INCY-1", channel: "C1", thread: "1.1", reporter: "U9" });
  const blocks = threadBlocks({ key: "INCY-1", url: "https://j/browse/INCY-1", reporter: "U9", ref });
  const actions = blocks.find((b) => b.type === "actions");
  assert.deepEqual(actions.elements.map((e) => e.action_id), ["incident_mitigated"]);
  assert.equal(actions.elements[0].style, "primary");
  assert.equal(decodeRef(actions.elements[0].value).key, "INCY-1");
  const text = blocks[0].text.text;
  assert.match(text, /Mark as mitigated when the immediate impact or disruption/);
  assert.ok(!text.includes("resolved"));
});

test("createdBlocks offers the thread as a green button, not a bare url", () => {
  const blocks = createdBlocks({ key: "INCY-1", channel: "C_INC", threadUrl: "https://s/archives/C/p1" });
  const [dismiss, view] = blocks.find((b) => b.type === "actions").elements;
  assert.equal(dismiss.text.text, "Dismiss");
  assert.equal(dismiss.style, undefined, "Dismiss is the quiet one");
  assert.equal(view.style, "primary");
  assert.equal(view.text.text, "View INCY-1 thread");
  assert.equal(view.url, "https://s/archives/C/p1");
  // A bare permalink would unfurl into a preview several lines tall.
  assert.ok(!blocks[0].text.text.includes("https://"));
});

// getPermalink is best-effort, so the message has to stand without it.
test("createdBlocks keeps Dismiss when there is no permalink", () => {
  const blocks = createdBlocks({ key: "INCY-1", channel: "C_INC", threadUrl: "" });
  assert.deepEqual(
    blocks.find((b) => b.type === "actions").elements.map((e) => e.action_id),
    ["incident_dismiss"],
  );
});

test("statusChannelText names the key, the status and the human", () => {
  assert.equal(
    statusChannelText({ key: "INCY-1", status: "mitigated", who: "Ann Example" }),
    ":large_orange_circle: *INCY-1* marked as *Mitigated* by Ann Example",
  );
  assert.equal(
    statusChannelText({ key: "INCY-905", status: "resolved", who: "Ann Example" }),
    ":white_check_mark: *INCY-905* marked as *Resolved* by Ann Example",
  );
  // A revert is a correction; "marked as" would read as just another step.
  assert.equal(
    statusChannelText({ key: "INCY-905", status: "open", who: "Reece Como" }),
    ":x: *INCY-905* reverted to *Open* by Reece Como",
  );
});

test("statusThreadBlocks offers the next step for each status", () => {
  const ref = encodeRef({ key: "INCY-1", channel: "C1", thread: "1.1", reporter: "U9" });
  const at = (status) =>
    statusThreadBlocks({ key: "INCY-1", url: "https://j/browse/INCY-1", status, who: "Ann", ref });
  const ids = (blocks) => blocks.find((b) => b.type === "actions").elements.map((e) => e.action_id);
  const styles = (blocks) => blocks.find((b) => b.type === "actions").elements.map((e) => e.style);

  assert.deepEqual(ids(at("mitigated")), ["incident_reopen", "incident_resolved"]);
  assert.deepEqual(styles(at("mitigated")), ["danger", "primary"]);
  assert.deepEqual(ids(at("resolved")), ["incident_draft_report", "incident_skip_report"]);
  assert.deepEqual(styles(at("resolved")), ["primary", undefined]);
  // Reverting puts it back where it started, buttons and all.
  assert.deepEqual(ids(at("open")), ["incident_mitigated"]);
});

test("only a resolved incident promises the auto-close", () => {
  const ref = encodeRef({ key: "INCY-1", channel: "C1", thread: "1.1", reporter: "U9" });
  const text = (status) =>
    statusThreadBlocks({ key: "INCY-1", url: "https://j/browse/INCY-1", status, who: "Ann", ref })[0].text.text;

  assert.equal(
    text("resolved"),
    ":white_check_mark: *<https://j/browse/INCY-1|INCY-1>* marked as *Resolved* by Ann\n\n_Incident will auto-close once incident report is attached_",
  );
  assert.ok(!text("mitigated").includes("auto-close"));
  assert.ok(!text("open").includes("auto-close"));
});

// The contract that actually matters: Dusty's proxy takes the FIRST non-Dusty
// mention as the session's actor, and ignores a bot message that tags only
// itself. Assert against the real classifier, not a restatement of it.
test("draftReportPrompt wakes Dusty with the requester as the actor", () => {
  const text = draftReportPrompt({ dustyUserId: "U_DUSTY", key: "INCY-1", requester: "U9" });
  const out = classifyMention(
    { type: "app_mention", channel: "C1", ts: "1.1", thread_ts: "1.0", bot_id: "B_INC", app_id: "A_INC", text },
    { teamId: "T1", allowedTeam: "T1", allowedBots: new Set(["A_INC"]), selfUserId: "U_DUSTY" },
  );
  assert.equal(out?.actor, "U9");
  assert.ok(out.body.includes("Set the 'Incident report' url in INCY-1"));
});

test("thanksBlocks drops the report button when no Notion url is configured", () => {
  const withUrl = thanksBlocks({ key: "INCY-1", threadUrl: "u", issueUrl: "i", reportUrl: "n" });
  const without = thanksBlocks({ key: "INCY-1", threadUrl: "u", issueUrl: "i", reportUrl: null });
  assert.equal(withUrl.at(-1).elements.length, 3);
  assert.equal(without.at(-1).elements.length, 2);
  assert.ok(without.at(-1).elements.every((e) => typeof e.url === "string" && e.url));
});

test("findAccountId matches the email case-insensitively", async () => {
  const jira = async () => [{ accountId: "5a6", emailAddress: "Ann@Healthengine.com.au" }];
  assert.equal(await findAccountId(jira, "ann@healthengine.com.au"), "5a6");
});

test("findAccountId gives up quietly when Jira hides the email", async () => {
  const jira = async () => [{ accountId: "5a6" }];
  assert.equal(await findAccountId(jira, "ann@healthengine.com.au"), null);
});

test("findAccountId survives a failing lookup rather than blocking the incident", async () => {
  const jira = async () => {
    throw new Error("403");
  };
  assert.equal(await findAccountId(jira, "ann@healthengine.com.au"), null);
});

// The Incident Slack field holds the thread, so the description does not.
test("incidentDescription is one unadorned sentence", () => {
  const doc = incidentDescription({ who: "Ann Example" });
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.equal(doc.content.length, 1);
  assert.deepEqual(doc.content[0].content, [
    { type: "text", text: "Raised via Slack by Ann Example" },
  ]);
});

// Transition ids are per-workflow; matching the destination STATUS id is what
// keeps the buttons working after someone edits or renames on the board.
test("transitionTo matches the destination status by id, not its name", async () => {
  const calls = [];
  const jira = async (path, opts) => {
    calls.push({ path, opts });
    if (opts?.method === "POST") return null;
    return {
      transitions: [
        { id: "11", to: { id: "11987", name: "Renamed since" } },
        { id: "21", to: { id: "11986", name: "Resolved" } },
      ],
    };
  };
  await transitionTo(jira, "INCY-1", STATUS.mitigated, LABEL.mitigated);
  assert.equal(calls.at(-1).opts.body.transition.id, "11");
});

// Two people pressing at once, or a retry after a partial failure.
test("transitionTo is a no-op when the issue is already there", async () => {
  const calls = [];
  const jira = async (path, opts) => {
    calls.push({ path, opts });
    if (path.endsWith("/transitions")) return { transitions: [] };
    return { fields: { status: { id: "11986", name: "Resolved" } } };
  };
  await transitionTo(jira, "INCY-1", STATUS.resolved, LABEL.resolved);
  assert.ok(!calls.some((c) => c.opts?.method === "POST"));
});

test("transitionTo names what was reachable when the status is not", async () => {
  const jira = async (path) =>
    path.endsWith("/transitions")
      ? { transitions: [{ id: "21", to: { id: "11986", name: "Resolved" } }] }
      : { fields: { status: { id: "11985", name: "Open" } } };
  await assert.rejects(
    () => transitionTo(jira, "INCY-1", STATUS.mitigated, LABEL.mitigated),
    /no transition to "Mitigated" from Open \(available: Resolved\)/,
  );
});


test("prefillSummary capitalises the first letter and leaves the rest alone", () => {
  assert.equal(prefillSummary("the booking form has exploded"), "The booking form has exploded");
  assert.equal(prefillSummary("  SES keys rotated, email stuck  "), "SES keys rotated, email stuck");
});

test("prefillSummary returns empty for nothing typed", () => {
  assert.equal(prefillSummary(""), "");
  assert.equal(prefillSummary(undefined), "");
});

// Slack refuses to open a view whose initial_value is longer than max_length.
test("prefillSummary truncates to the field's own limit", () => {
  const long = "x".repeat(200);
  const modal = incidentModal({ text: long });
  const input = modal.blocks[0].element;
  assert.equal(input.initial_value.length, input.max_length);
});

test("incidentModal leaves initial_value off when nothing was typed", () => {
  assert.equal(incidentModal({}).blocks[0].element.initial_value, undefined);
  assert.equal(incidentModal({ text: "boom" }).blocks[0].element.initial_value, "Boom");
});

test("unescapeSlackText unwraps channels, users and group mentions", () => {
  assert.equal(
    unescapeSlackText("<#C1|bookings> is down, ask <@U1|ann> or <!subteam^S1|@platform>"),
    "#bookings is down, ask @ann or @platform",
  );
  assert.equal(unescapeSlackText("<!here> bookings are failing"), "@here bookings are failing");
});

test("unescapeSlackText prefers a link's label, else the url", () => {
  assert.equal(unescapeSlackText("see <https://x.test/run|the build>"), "see the build");
  assert.equal(unescapeSlackText("see <https://x.test/run>"), "see https://x.test/run");
});

test("unescapeSlackText keeps the reference when Slack sends no label", () => {
  assert.equal(unescapeSlackText("<#C1> broke"), "#C1 broke");
});

// Entities are decoded after the markup, or &lt; would be parsed as markup.
test("unescapeSlackText decodes entities without re-parsing them", () => {
  assert.equal(unescapeSlackText("bookings &amp; payments"), "bookings & payments");
  assert.equal(unescapeSlackText("&lt;script&gt; in the summary"), "<script> in the summary");
});

test("prefillSummary unescapes before capitalising", () => {
  assert.equal(
    prefillSummary("<#C1|bookings> form has exploded"),
    "#bookings form has exploded",
  );
});



test("jiraClient sends Basic auth to the api.atlassian.com gateway", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const jira = jiraClient({ email: "a@b.c", token: "t", cloudId: "test-cloud" });
    await jira("/rest/api/3/myself");
    assert.equal(seen[0].url, "https://api.atlassian.com/ex/jira/test-cloud/rest/api/3/myself");
    assert.equal(seen[0].auth, "Basic " + Buffer.from("a@b.c:t").toString("base64"));

    // A missing cloud id put the string "undefined" in the path and 404'd; fail loudly instead.
    assert.throws(() => jiraClient({ email: "a@b.c", token: "t" }), /cloudId is required/);
  } finally {
    globalThis.fetch = original;
  }
});
