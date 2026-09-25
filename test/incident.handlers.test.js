import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { register } from "../lib/incident/index.js";

const SECRET = "shhh";

const ENV = {
  INCIDENT_JIRA_CLOUD_ID: "test-cloud",
  INCIDENT_SLACK_SIGNING_SECRET: SECRET,
  INCIDENT_SLACK_BOT_TOKEN: "xoxb-test",
  INCIDENT_CHANNEL_ID: "C_INC",
  INCIDENT_DUSTY_USER_ID: "U_DUSTY",
  INCIDENT_JIRA_BASE_URL: "https://hejira.atlassian.net",
  INCIDENT_JIRA_EMAIL: "svc@healthengine.com.au",
  INCIDENT_JIRA_API_TOKEN: "tok",
};

function withEnv(overrides = {}) {
  const previous = {};
  for (const [k, v] of Object.entries({ ...ENV, ...overrides })) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// Probot's contract: getRouter is a FUNCTION IN THE SECOND ARG, not a method on app.
function makeHarness({ getRouter = true } = {}) {
  const routes = [];
  const warnings = [];
  const app = { log: { warn: (m) => warnings.push(m) } };
  const router = { post: (path, ...handlers) => routes.push({ path, handlers }) };
  const options = getRouter ? { getRouter: () => router } : {};
  return { app, options, routes, warnings };
}

async function post({ routes, path, headers = {}, raw }) {
  const req = Object.assign(new EventEmitter(), { headers, method: "POST" });
  let statusCode;
  let sent;
  const res = {
    status(code) { statusCode = code; return res; },
    send(payload) { sent = payload ?? ""; return res; },
    json(payload) { sent = payload; return res; },
  };
  const { handlers } = routes.find((r) => r.path === path);
  const run = (i) => (i >= handlers.length ? undefined : handlers[i](req, res, () => run(i + 1)));
  const pending = run(0);
  req.emit("data", Buffer.from(raw));
  req.emit("end");
  await pending;
  for (let i = 0; i < 300; i++) await Promise.resolve();
  return { statusCode, sent };
}

function signedHeaders(raw, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex"),
  };
}

// Records every Slack/Jira call the handler makes, so tests assert on effects
// rather than on internals.
function stubFetch({ transitions, slack = {} } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  const state = { transitions: transitions ?? [{ id: "11", to: { id: "11987", name: "Impact mitigated" } }, { id: "21", to: { id: "11986", name: "Resolved" } }] };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const method = String(url).match(/^https:\/\/slack\.com\/api\/([^?]+)/)?.[1];
    const body = String(url).endsWith("/transitions")
      ? { transitions: state.transitions }
      : (typeof slack[method] === "function" ? slack[method](String(url)) : slack[method]) ??
        { ok: true, ts: "111.1", key: "INCY-1", fields: {} };
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  return {
    calls,
    get transitions() { return state.transitions; },
    set transitions(v) { state.transitions = v; },
    restore: () => { globalThis.fetch = original; },
  };
}

test("register mounts both incident routes via getRouter", () => {
  const restore = withEnv();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    assert.deepEqual(h.routes.map((r) => r.path), ["/slack/incident/command", "/slack/incident/interact"]);
  } finally {
    restore();
  }
});

test("register no-ops (no throw) when getRouter is unavailable", () => {
  const restore = withEnv();
  try {
    const h = makeHarness({ getRouter: false });
    assert.doesNotThrow(() => register(h.app, h.options));
    assert.equal(h.routes.length, 0);
    assert.equal(h.warnings.length, 1);
  } finally {
    restore();
  }
});

test("register tolerates being called with no options at all", () => {
  assert.doesNotThrow(() => register({}));
});

// A half-configured deploy must not mount a command that will fail mid-incident.
test("register refuses to mount when configuration is incomplete", () => {
  for (const key of ["INCIDENT_CHANNEL_ID", "INCIDENT_DUSTY_USER_ID", "INCIDENT_JIRA_CLOUD_ID", "INCIDENT_JIRA_EMAIL", "INCIDENT_JIRA_API_TOKEN"]) {
    const restore = withEnv({ [key]: undefined });
    try {
      const h = makeHarness();
      register(h.app, h.options);
      assert.equal(h.routes.length, 0, `${key} should block mounting`);
      assert.match(h.warnings[0], new RegExp(key));
    } finally {
      restore();
    }
  }
});

test("an unsigned /incident is rejected and opens nothing", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = "trigger_id=T1&user_id=U9";
    const { statusCode } = await post({ routes: h.routes, path: "/slack/incident/command", headers: { "x-slack-signature": "v0=dead", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) }, raw });
    assert.equal(statusCode, 401);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("/incident acks immediately and opens the modal with the trigger_id", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = "trigger_id=T1&user_id=U9";
    const { statusCode } = await post({ routes: h.routes, path: "/slack/incident/command", headers: signedHeaders(raw), raw });
    assert.equal(statusCode, 200);
    const open = fetchStub.calls.find((c) => c.url.endsWith("views.open"));
    assert.ok(open, "expected views.open");
    assert.equal(open.body.trigger_id, "T1");
    assert.equal(open.body.view.callback_id, "incident_create");
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("INCIDENT_JIRA_CLOUD_ID sets the REST base", async () => {
  const restore = withEnv({ INCIDENT_JIRA_CLOUD_ID: "other-cloud" });
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const payload = {
      type: "view_submission",
      user: { id: "U9" },
      view: { callback_id: "incident_create", state: { values: { summary: { value: { value: "Bookings failing" } } } } },
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });
    const created = fetchStub.calls.find((c) => c.url.endsWith("/rest/api/3/issue"));
    assert.equal(created.url, "https://api.atlassian.com/ex/jira/other-cloud/rest/api/3/issue");
  } finally {
    fetchStub.restore();
    restore();
  }
});

// One ephemeral, not two: a progress note could not be replaced reliably and
// stacked on top of the result instead.
test("submitting the modal answers the command exactly once", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  const responses = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://hooks.slack.test/")) {
      responses.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
    }
    if (String(url).includes("chat.getPermalink")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, permalink: "https://s/archives/C_INC/p1" }),
        text: async () => "",
      };
    }
    return original(url, init);
  };
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const payload = {
      type: "view_submission",
      user: { id: "U9" },
      view: {
        callback_id: "incident_create",
        private_metadata: JSON.stringify({ responseUrl: "https://hooks.slack.test/r1" }),
        state: { values: { summary: { value: { value: "Bookings failing" } } } },
      },
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    assert.equal(responses.length, 1);
    assert.ok(!responses[0].replace_original, "nothing to replace");
    assert.deepEqual(
      responses[0].blocks.find((b) => b.type === "actions").elements.map((e) => e.action_id),
      ["incident_dismiss", "incident_view_thread"],
    );
  } finally {
    globalThis.fetch = original;
    fetchStub.restore();
    restore();
  }
});

test("Skip clears both report buttons and does nothing else", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const ref = JSON.stringify({ k: "INCY-1", c: "C_INC", t: "111.1", r: "U9" });
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      container: { channel_id: "C_INC", message_ts: "222.2" },
      message: { text: "INCY-1 marked as Resolved", blocks: [{ type: "section" }, { type: "actions" }] },
      actions: [{ action_id: "incident_skip_report", value: ref }],
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const update = fetchStub.calls.find((c) => c.url.endsWith("chat.update"));
    assert.deepEqual(update.body.blocks, [{ type: "section" }]);
    // No Dusty summons, no DM, no Jira.
    assert.ok(!fetchStub.calls.some((c) => c.url.endsWith("chat.postMessage")));
    assert.ok(!fetchStub.calls.some((c) => c.url.includes("/rest/api/")));
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("Dismiss and View incident thread both clear the ephemeral", async () => {
  const restore = withEnv();
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
  };
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      response_url: "https://hooks.slack.test/r1",
      // A url button carries no value, so this must be handled before the ref decode.
      actions: [{ action_id: "incident_view_thread", url: "https://s/archives/C/p1" }],
    };
    for (const action_id of ["incident_view_thread", "incident_dismiss"]) {
      payload.actions = [{ action_id }];
      const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
      await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });
    }

    assert.deepEqual(sent.map((c) => c.url), ["https://hooks.slack.test/r1", "https://hooks.slack.test/r1"]);
    assert.ok(sent.every((c) => c.body.delete_original === true));
  } finally {
    globalThis.fetch = original;
    restore();
  }
});

test("a malformed interaction payload is ignored rather than throwing", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = "payload=" + encodeURIComponent("{not json");
    const { statusCode } = await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });
    assert.equal(statusCode, 200);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("submitting the modal creates an INCY Incident and posts the triage message", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const payload = {
      type: "view_submission",
      user: { id: "U9" },
      view: { callback_id: "incident_create", state: { values: { summary: { value: { value: "Bookings failing" } } } } },
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    const { statusCode } = await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });
    assert.equal(statusCode, 200);

    const created = fetchStub.calls.find((c) => c.url.endsWith("/rest/api/3/issue"));
    assert.ok(created, "expected a Jira create");
    // Wiring, not just the client: a scoped token sent anywhere but the gateway
    // authenticates and then reports the project as missing.
    assert.equal(created.url, "https://api.atlassian.com/ex/jira/test-cloud/rest/api/3/issue");
    assert.equal(created.body.fields.project.key, "INCY");
    assert.equal(created.body.fields.issuetype.id, "10821");
    assert.equal(created.body.fields.summary, "Bookings failing");

    const posted = fetchStub.calls.find((c) => c.url.endsWith("chat.postMessage") && c.body.channel === "C_INC" && !c.body.thread_ts);
    assert.ok(posted, "expected a triage message");
    assert.ok(posted.body.text.includes("INCY-1"));
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("an empty summary submits nothing", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const payload = {
      type: "view_submission",
      user: { id: "U9" },
      view: { callback_id: "incident_create", state: { values: { summary: { value: { value: "   " } } } } },
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("Mark as resolved transitions, writes no fields, and removes the buttons", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const ref = JSON.stringify({ k: "INCY-1", c: "C_INC", t: "111.1", r: "U9" });
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      container: { channel_id: "C_INC", message_ts: "222.2" },
      message: {
        text: "INCY-1 raised",
        blocks: [{ type: "section" }, { type: "actions" }],
      },
      actions: [{ action_id: "incident_resolved", value: ref }],
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const moved = fetchStub.calls.find((c) => c.url.endsWith("/transitions") && c.body?.transition);
    assert.ok(moved, "expected a transition");
    assert.equal(moved.body.transition.id, "21");

    // Timestamps belong to the Jira automations that fire on the transition.
    const edited = fetchStub.calls.find((c) => c.url.endsWith("/issue/INCY-1") && c.body?.fields);
    assert.equal(edited, undefined, "must not write any issue fields");

    const update = fetchStub.calls.find((c) => c.url.endsWith("chat.update"));
    assert.ok(update, "expected the buttons to be removed");
    assert.equal(update.body.ts, "222.2");
    assert.deepEqual(update.body.blocks, [{ type: "section" }]);
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("Revert to open transitions back, re-pins, and stays out of the channel", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch({ transitions: [{ id: "31", to: { id: "11985", name: "Open" } }] });
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const ref = JSON.stringify({ k: "INCY-905", c: "C_INC", t: "111.1", r: "U9" });
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      container: { channel_id: "C_INC", message_ts: "222.2" },
      message: { text: "INCY-905 marked as Mitigated", blocks: [{ type: "section" }, { type: "actions" }] },
      actions: [{ action_id: "incident_reopen", value: ref }],
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const moved = fetchStub.calls.find((c) => c.url.endsWith("/transitions") && c.body?.transition);
    assert.equal(moved.body.transition.id, "31");

    // Live again, so the triage message goes back on the pin board and the siren.
    assert.ok(fetchStub.calls.some((c) => c.url.endsWith("pins.add") && c.body.timestamp === "111.1"));
    const reacted = fetchStub.calls.find((c) => c.url.endsWith("reactions.add"));
    assert.equal(reacted.body.name, "rotating_light");
    assert.ok(
      fetchStub.calls.some((c) => c.url.endsWith("reactions.remove") && c.body.name === "large_orange_circle"),
      "expected the mitigated reaction cleared",
    );

    // A revert is a working update; only resolution interrupts the channel.
    const channelPost = fetchStub.calls.find((c) => c.url.endsWith("chat.postMessage") && !c.body.thread_ts);
    assert.equal(channelPost, undefined, "must not post to the channel");

    const threadPost = fetchStub.calls.find((c) => c.url.endsWith("chat.postMessage") && c.body.thread_ts === "111.1");
    assert.deepEqual(
      threadPost.body.blocks.find((b) => b.type === "actions").elements.map((e) => e.action_id),
      ["incident_mitigated"],
    );
  } finally {
    fetchStub.restore();
    restore();
  }
});

// The bug this guards: claiming a dedupe key before the work meant a failed
// press was dead and silent for ten minutes.
test("a failed transition leaves the buttons in place so it can be retried", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch({ transitions: [] });
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const ref = JSON.stringify({ k: "INCY-1", c: "C_INC", t: "111.1", r: "U9" });
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      container: { channel_id: "C_INC", message_ts: "222.2" },
      message: { text: "INCY-1 raised", blocks: [{ type: "section" }, { type: "actions" }] },
      actions: [{ action_id: "incident_resolved", value: ref }],
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    assert.equal(fetchStub.calls.find((c) => c.url.endsWith("chat.update")), undefined, "buttons must survive a failure");

    // And the same press works the second time, rather than being swallowed.
    fetchStub.calls.length = 0;
    fetchStub.transitions = [{ id: "21", to: { id: "11986", name: "Resolved" } }];
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });
    assert.ok(fetchStub.calls.find((c) => c.url.endsWith("/transitions") && c.body?.transition), "retry must reach Jira");
  } finally {
    fetchStub.restore();
    restore();
  }
});

const BOOKINGS = { id: "C_BOOK", name: "bookings", postable: true };

function submission({ destination, origin = null, summary = "Bookings failing" } = {}) {
  const payload = {
    type: "view_submission",
    user: { id: "U9" },
    view: {
      callback_id: "incident_create",
      private_metadata: JSON.stringify({ responseUrl: null, origin }),
      state: {
        values: {
          summary: { value: { value: summary } },
          ...(destination ? { destination: { value: { selected_option: { value: destination } } } } : {}),
        },
      },
    },
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

function press(action_id, ref) {
  const payload = {
    type: "block_actions",
    user: { id: "U9" },
    container: { channel_id: ref.c, message_ts: "222.2" },
    message: { text: `${ref.k} update`, blocks: [{ type: "section" }, { type: "actions" }] },
    actions: [{ action_id, value: JSON.stringify(ref) }],
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

const ANN = { "users.info": { ok: true, user: { profile: { real_name: "Ann Example" } } } };

test("/incident looks the channel up first and offers it as the default", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch({
    slack: {
      "conversations.info": (url) =>
        url.includes("C_BOOK")
          ? { ok: true, channel: { id: "C_BOOK", name: "bookings", is_channel: true } }
          : { ok: true, channel: { id: "C_INC", name: "incidents", is_channel: true } },
    },
  });
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = "trigger_id=T1&user_id=U9&channel_id=C_BOOK&channel_name=bookings";
    await post({ routes: h.routes, path: "/slack/incident/command", headers: signedHeaders(raw), raw });

    const lookup = fetchStub.calls.findIndex((c) => c.url.includes("conversations.info?channel=C_BOOK"));
    const open = fetchStub.calls.findIndex((c) => c.url.endsWith("views.open"));
    assert.ok(lookup !== -1 && lookup < open, "expected the lookup ahead of views.open");
    const radio = fetchStub.calls[open].body.view.blocks.find((b) => b.block_id === "destination").element;
    assert.equal(radio.initial_option.value, "current");
    assert.deepEqual(radio.options.map((o) => o.text.text).slice(0, 2), ["#bookings", "#incidents"]);
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("/incident from a DM skips the lookup and defaults to #incidents", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = "trigger_id=T1&user_id=U9&channel_id=D123&channel_name=directmessage";
    await post({ routes: h.routes, path: "/slack/incident/command", headers: signedHeaders(raw), raw });

    assert.ok(!fetchStub.calls.some((c) => c.url.includes("conversations.info?channel=D123")));
    const open = fetchStub.calls.find((c) => c.url.endsWith("views.open"));
    const radio = open.body.view.blocks.find((b) => b.block_id === "destination").element;
    assert.equal(radio.initial_option.value, "incidents");
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("choosing this channel triages there, and the Jira description names it", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch({ slack: ANN });
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = submission({ destination: "current", origin: BOOKINGS });
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const created = fetchStub.calls.find((c) => c.url.endsWith("/rest/api/3/issue"));
    assert.equal(created.body.fields.summary, "Bookings failing");
    assert.equal(
      created.body.fields.description.content[0].content[0].text,
      "Raised via Slack by Ann Example in #bookings",
    );

    const [triage, tracker] = fetchStub.calls.filter((c) => c.url.endsWith("chat.postMessage"));
    assert.equal(triage.body.channel, "C_BOOK");
    assert.equal(triage.body.thread_ts, undefined);
    assert.equal(tracker.body.channel, "C_BOOK");
    assert.equal(tracker.body.thread_ts, "111.1");
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("choosing #incidents from another channel still names where it was raised", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch({ slack: ANN });
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = submission({ destination: "incidents", origin: BOOKINGS });
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const created = fetchStub.calls.find((c) => c.url.endsWith("/rest/api/3/issue"));
    assert.match(created.body.fields.description.content[0].content[0].text, /in #bookings$/);
    const triage = fetchStub.calls.find((c) => c.url.endsWith("chat.postMessage"));
    assert.equal(triage.body.channel, "C_INC");
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("a dedicated channel is private and code-named, with the summary kept inside it", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch({
    slack: { ...ANN, "conversations.create": { ok: true, channel: { id: "C_NEW" } } },
  });
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = submission({ destination: "dedicated", origin: BOOKINGS });
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const made = fetchStub.calls.find((c) => c.url.endsWith("conversations.create"));
    assert.equal(made.body.is_private, true);
    assert.match(made.body.name, /^incy-1-[a-z]+-[a-z]+$/);

    const invite = fetchStub.calls.find((c) => c.url.endsWith("conversations.invite"));
    assert.deepEqual(invite.body, { channel: "C_NEW", users: "U9" });

    const created = fetchStub.calls.find((c) => c.url.endsWith("/rest/api/3/issue"));
    assert.match(created.body.fields.summary, /^[A-Z][a-z]+ [A-Z][a-z]+ Incident$/);
    const slug = created.body.fields.summary.replace(/ Incident$/, "").toLowerCase().replace(" ", "-");
    assert.equal(made.body.name, `incy-1-${slug}`);
    assert.ok(
      !fetchStub.calls.some((c) => c.url.endsWith("/rest/api/3/issue/INCY-1") && c.body?.fields?.summary),
      "the code name is the summary for good",
    );
    assert.ok(
      !fetchStub.calls.some((c) => c.url.includes("/rest/api/") && JSON.stringify(c.body ?? {}).includes("Bookings failing")),
      "the summary must not reach Jira",
    );

    const inChannel = fetchStub.calls.filter((c) => c.url.endsWith("chat.postMessage") && c.body.channel === "C_NEW");
    assert.equal(inChannel.length, 2);
    assert.ok(inChannel.every((c) => c.body.thread_ts === undefined), "replies go to the channel, not a thread");
    assert.equal(inChannel[0].body.text, "*INCY-1 raised* - Bookings failing");
    const button = inChannel[1].body.blocks.find((b) => b.type === "actions").elements[0];
    assert.equal(JSON.parse(button.value).d, 1);
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("in a dedicated channel, resolving posts once, to the channel", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = press("incident_resolved", { k: "INCY-1", c: "C_NEW", t: "111.1", r: "U9", d: 1 });
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const posts = fetchStub.calls.filter((c) => c.url.endsWith("chat.postMessage"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.channel, "C_NEW");
    assert.equal(posts[0].body.thread_ts, undefined);
    const next = posts[0].body.blocks.find((b) => b.type === "actions").elements[0];
    assert.equal(JSON.parse(next.value).d, 1, "the next buttons keep the channel mode");
  } finally {
    fetchStub.restore();
    restore();
  }
});

test("in a dedicated channel, the report request goes to the channel", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const raw = press("incident_draft_report", { k: "INCY-1", c: "C_NEW", t: "111.1", r: "U9", d: 1 });
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const prompt = fetchStub.calls.find((c) => c.url.endsWith("chat.postMessage") && c.body.channel === "C_NEW");
    assert.equal(prompt.body.thread_ts, undefined);
    assert.match(prompt.body.text, /^<@U_DUSTY> .*See channel for details/);
  } finally {
    fetchStub.restore();
    restore();
  }
});
