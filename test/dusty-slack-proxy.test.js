import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { verifySlackSignature, classifyMention, ackReceived } from "../lib/dusty-slack-proxy.js";

const SECRET = "shhh";
const sign = (rawBody, ts, secret = SECRET) =>
  "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");

test("verifySlackSignature accepts a correctly signed, fresh request", () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);
  const rawBody = '{"type":"event_callback"}';
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody, signature: sign(rawBody, ts), now }), true);
});

test("verifySlackSignature rejects a bad signature", () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: "{}", signature: "v0=deadbeef", now }), false);
});

test("verifySlackSignature rejects a wrong secret", () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: "{}", signature: sign("{}", ts, "other"), now }), false);
});

test("verifySlackSignature rejects a stale timestamp (replay)", () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000) - 600;
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: "{}", signature: sign("{}", ts), now }), false);
});

test("classifyMention extracts coords, actor and strips the bot tag", () => {
  const out = classifyMention(
    { type: "app_mention", channel: "C123", ts: "111.1", thread_ts: "100.1", user: "U9", text: "<@B01> fix the build" },
    { teamId: "T1", allowedTeam: "T1" },
  );
  assert.deepEqual(out, {
    event: "slack", slack_channel: "C123", slack_thread: "100.1", slack_ts: "111.1",
    slack_team: "T1", actor: "U9", body: "fix the build",
  });
});

test("classifyMention uses ts as the thread key when not already in a thread", () => {
  const out = classifyMention({ type: "app_mention", channel: "C1", ts: "222.2", user: "U9", text: "<@B01> hi" }, { teamId: "T1", allowedTeam: "T1" });
  assert.equal(out.slack_thread, "222.2");
});

test("classifyMention ignores our own / other bot messages", () => {
  assert.equal(classifyMention({ type: "app_mention", channel: "C1", ts: "1.1", user: "U9", bot_id: "B01", text: "x" }, {}), null);
  assert.equal(classifyMention({ type: "app_mention", channel: "C1", ts: "1.1", user: "U9", app_id: "A01", text: "x" }, {}), null);
});

test("classifyMention ignores a foreign workspace", () => {
  assert.equal(classifyMention({ type: "app_mention", channel: "C1", ts: "1.1", user: "U9", text: "<@B01> hi" }, { teamId: "T_OTHER", allowedTeam: "T1" }), null);
});

test("classifyMention ignores non-app_mention events", () => {
  assert.equal(classifyMention({ type: "message", channel: "C1", ts: "1.1", user: "U9" }, {}), null);
  assert.equal(classifyMention(null, {}), null);
});

// --- ackReceived -------------------------------------------------------------
//
// Pure decoration, so every failure mode here must be silent.

test("ackReceived joins before reacting — reactions.add needs membership", async () => {
  const calls = [];
  const call = async (method, body) => { calls.push({ method, body }); return { ok: true }; };
  await ackReceived({ channel: "C1", ts: "1.1", token: "xoxb-x", call });
  assert.deepEqual(calls.map((c) => c.method), ["conversations.join", "reactions.add"]);
  assert.equal(calls[0].body.channel, "C1");
  assert.deepEqual(calls[1].body, { channel: "C1", timestamp: "1.1", name: "dusty_is_on_it" });
});

test("ackReceived does nothing without a bot token", async () => {
  const calls = [];
  const call = async (method) => { calls.push(method); return { ok: true }; };
  await ackReceived({ channel: "C1", ts: "1.1", token: "", call });
  assert.deepEqual(calls, []);
});

test("ackReceived does nothing without Slack coords", async () => {
  const calls = [];
  const call = async (method) => { calls.push(method); return { ok: true }; };
  await ackReceived({ channel: "", ts: "1.1", token: "xoxb-x", call });
  await ackReceived({ channel: "C1", ts: "", token: "xoxb-x", call });
  assert.deepEqual(calls, []);
});

test("ackReceived still reacts when the join is refused", async () => {
  const calls = [];
  const call = async (method) => {
    calls.push(method);
    return method === "conversations.join" ? { ok: false, error: "method_not_supported_for_channel_type" } : { ok: true };
  };
  await ackReceived({ channel: "C1", ts: "1.1", token: "xoxb-x", call });
  assert.deepEqual(calls, ["conversations.join", "reactions.add"]);
});

test("ackReceived swallows an already_reacted refusal", async () => {
  const call = async () => ({ ok: false, error: "already_reacted" });
  await assert.doesNotReject(ackReceived({ channel: "C1", ts: "1.1", token: "xoxb-x", call }));
});

test("ackReceived swallows a thrown transport error", async () => {
  const call = async () => { throw new Error("ECONNRESET"); };
  await assert.doesNotReject(ackReceived({ channel: "C1", ts: "1.1", token: "xoxb-x", call }));
});

test("ackReceived gives up rather than hanging when Slack does not answer", async () => {
  // The real slackCall aborts at 5s; this asserts the caller survives whatever it returns.
  const call = async () => { const e = new Error("The operation was aborted"); e.name = "TimeoutError"; throw e; };
  await assert.doesNotReject(ackReceived({ channel: "C1", ts: "1.1", token: "xoxb-x", call }));
});
