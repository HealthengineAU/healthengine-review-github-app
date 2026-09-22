// Jira: the REST client, and the pure helpers that shape what we send it.

import { JIRA_TIMEOUT_MS } from "./constants.js";

// Jira's REST v3 takes Atlassian Document Format, not a string.
export function adf(text) {
  const paragraphs = String(text ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
  return { type: "doc", version: 1, content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }] };
}

// Perth is UTC+8 year-round, and Jira wants a colon-less offset with millis.
export function jiraTimestamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+0800");
}


export function browseUrl(baseUrl, key) {
  return `${String(baseUrl).replace(/\/+$/, "")}/browse/${key}`;
}

export function jiraClient({ baseUrl, email, token }) {
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  const root = String(baseUrl).replace(/\/+$/, "");

  return async function call(path, { method = "GET", body } = {}) {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`jira ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  };
}

// Jira hides email addresses under some privacy settings, in which case the
// service user stays the reporter — an issue with the wrong reporter beats no
// issue at all.
export async function findAccountId(jira, email) {
  if (!email) return null;
  const users = await jira(`/rest/api/3/user/search?query=${encodeURIComponent(email)}`).catch(() => null);
  const match = (users ?? []).find((u) => u?.emailAddress?.toLowerCase() === email.toLowerCase());
  return match?.accountId ?? null;
}

// Jira's REST v3 takes ADF, so anything richer than a sentence has to be built.
export function incidentDescription({ who, threadUrl }) {
  const content = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Raised from Slack by " },
        { type: "text", text: who, marks: [{ type: "strong" }] },
        { type: "text", text: "." },
      ],
    },
  ];

  if (threadUrl) {
    content.push({
      type: "paragraph",
      content: [
        { type: "text", text: "View the Slack thread", marks: [{ type: "link", attrs: { href: threadUrl } }] },
      ],
    });
  }

  return { type: "doc", version: 1, content };
}

// Transitions are matched by destination status name: a transition id is
// per-workflow and changes when the board is edited, and the wrong one fails as
// an opaque 400. Throws with what WAS available, so the Slack error is legible.
export async function transitionTo(jira, key, statusName) {
  const { transitions = [] } = (await jira(`/rest/api/3/issue/${key}/transitions`)) ?? {};
  const match = transitions.find((t) => t.to?.name?.toLowerCase() === String(statusName).toLowerCase());

  if (!match) {
    const available = transitions.map((t) => t.to?.name).filter(Boolean).join(", ") || "none";
    throw new Error(`${key}: no transition to "${statusName}" from its current status (available: ${available})`);
  }

  await jira(`/rest/api/3/issue/${key}/transitions`, { method: "POST", body: { transition: { id: match.id } } });
}
