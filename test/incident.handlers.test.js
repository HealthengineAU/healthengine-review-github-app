import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { register } from "../lib/incident/index.js";

const SECRET = "shhh";

const ENV = {
  INCIDENT_SLACK_SIGNING_SECRET: SECRET,
  INCIDENT_SLACK_BOT_TOKEN: "xoxb-test",
  INCIDENT_CHANNEL_ID: "C_INC",
  INCIDENT_DUSTY_USER_ID: "U_DUSTY",
  INCIDENT_JIRA_BASE_URL: "https://hejira.atlassian.net",
  INCIDENT_JIRA_CLOUD_ID: "cloud-1",
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
  for (let i = 0; i < 50; i++) await Promise.resolve();
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
function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const body = String(url).endsWith("/transitions")
      ? { transitions: [{ id: "11", to: { name: "Impact mitigated" } }, { id: "21", to: { name: "Resolved" } }] }
      : { ok: true, ts: "111.1", key: "INCY-1", fields: {} };
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
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
  for (const key of ["INCIDENT_CHANNEL_ID", "INCIDENT_DUSTY_USER_ID", "INCIDENT_JIRA_EMAIL", "INCIDENT_JIRA_API_TOKEN", "INCIDENT_JIRA_CLOUD_ID"]) {
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

test("Mark as resolved transitions the issue instead of renaming it", async () => {
  const restore = withEnv();
  const fetchStub = stubFetch();
  try {
    const h = makeHarness();
    register(h.app, h.options);
    const ref = JSON.stringify({ k: "INCY-1", c: "C_INC", t: "111.1", r: "U9" });
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      actions: [{ action_id: "incident_resolved", value: ref }],
    };
    const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
    await post({ routes: h.routes, path: "/slack/incident/interact", headers: signedHeaders(raw), raw });

    const stamped = fetchStub.calls.find((c) => c.url.endsWith("/issue/INCY-1") && c.body?.fields);
    assert.ok(stamped, "expected a field update");
    assert.ok(stamped.body.fields.customfield_12728, "Incident resolved should be stamped");
    assert.equal(stamped.body.fields.summary, undefined, "the summary must not be renamed any more");

    const moved = fetchStub.calls.find((c) => c.url.endsWith("/transitions") && c.body?.transition);
    assert.ok(moved, "expected a transition");
    assert.equal(moved.body.transition.id, "21");
  } finally {
    fetchStub.restore();
    restore();
  }
});
