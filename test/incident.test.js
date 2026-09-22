import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyMention } from "../lib/dusty-slack-proxy.js";
import {
  decodeRef,
  unescapeSlackText,
  prefillSummary,
  draftReportPrompt,
  encodeRef,
  incidentModal,
  statusChannelText,
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
  assert.equal(text, "*Incident <https://j/browse/INCY-1|INCY-1> raised* - Bookings failing - please reply in thread :thread:");
  assert.ok(!text.includes("]("));
});

test("threadBlocks puts the same ref on both status buttons", () => {
  const ref = encodeRef({ key: "INCY-1", channel: "C1", thread: "1.1", reporter: "U9" });
  const blocks = threadBlocks({ key: "INCY-1", url: "https://j/browse/INCY-1", reporter: "U9", ref });
  const actions = blocks.find((b) => b.type === "actions");
  assert.deepEqual(
    actions.elements.map((e) => e.action_id),
    ["incident_mitigated", "incident_resolved"],
  );
  assert.ok(actions.elements.every((e) => decodeRef(e.value).key === "INCY-1"));
});

test("statusChannelText names the key, the status and the human", () => {
  assert.equal(
    statusChannelText({ key: "INCY-1", status: "mitigated", who: "Ann Example" }),
    ":white_check_mark: *INCY-1* marked as *Mitigated* by Ann Example",
  );
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

test("incidentDescription names the reporter in bold", () => {
  const doc = incidentDescription({ who: "Ann Example" });
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  const bold = doc.content[0].content.find((n) => n.marks?.[0]?.type === "strong");
  assert.equal(bold.text, "Ann Example");
});

test("incidentDescription links the thread only once there is one", () => {
  const before = incidentDescription({ who: "Ann Example" });
  const after = incidentDescription({ who: "Ann Example", threadUrl: "https://slack.example/x" });
  assert.equal(before.content.length, 1);
  assert.equal(after.content.length, 2);
  assert.equal(after.content[1].content[0].marks[0].attrs.href, "https://slack.example/x");
});

// Transition ids are per-workflow; matching the destination name is what keeps
// the buttons working after someone edits the board.
test("transitionTo matches the destination status by name, ignoring case", async () => {
  const calls = [];
  const jira = async (path, opts) => {
    calls.push({ path, opts });
    if (opts?.method === "POST") return null;
    return { transitions: [{ id: "11", to: { name: "Impact mitigated" } }, { id: "21", to: { name: "Resolved" } }] };
  };
  await transitionTo(jira, "INCY-1", "impact MITIGATED");
  assert.equal(calls.at(-1).opts.body.transition.id, "11");
});

test("transitionTo names what was reachable when the status is not", async () => {
  const jira = async () => ({ transitions: [{ id: "21", to: { name: "Resolved" } }] });
  await assert.rejects(() => transitionTo(jira, "INCY-1", "Impact mitigated"), /available: Resolved/);
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
