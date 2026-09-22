// Slack transport. Nothing here knows what an incident is.

import { SLACK_TIMEOUT_MS } from "./constants.js";

export { verifySlackSignature } from "../dusty-slack-proxy.js";

export async function slackCall(method, body, token) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new Error(`${method}: ${json?.error ?? res.status}`);
  return json;
}

export async function slackGet(method, params, token) {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new Error(`${method}: ${json?.error ?? res.status}`);
  return json;
}

// Decoration — a missing pin or reaction is never worth failing an incident over.
export async function soft(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// Raw bytes, not parsed fields — the signature covers the body exactly as sent.
export function rawBody(req, res, next) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks).toString("utf8");
    next();
  });
  req.on("error", next);
}

// response_url needs no auth — the URL itself is the credential, and it stays
// valid for 30 minutes after the interaction that produced it.
export async function postResponse(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ response_type: "ephemeral", ...body }),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`response_url: ${res.status}`);
}
