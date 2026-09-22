// Jira: the REST client, and the pure helpers that shape what we send it.

import { JIRA_TIMEOUT_MS } from "./constants.js";

// Perth is UTC+8 year-round, and Jira wants a colon-less offset with millis.
export function jiraTimestamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .replace("Z", "+0800");
}

export function browseUrl(baseUrl, key) {
  return `${String(baseUrl).replace(/\/+$/, "")}/browse/${key}`;
}

// Scoped API tokens are only honoured through the api.atlassian.com gateway.
// Sent to the site URL they still authenticate, but carry no scope grants, so
// Jira answers "the target project does not exist" — which is what a missing
// cloud id looks like from Slack. Auth is Basic either way.
//
// baseUrl stays the human site: it is what browse/ links are built from.
export function jiraClient({ cloudId, email, token }) {
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  const root = `https://api.atlassian.com/ex/jira/${cloudId}`;

  return async function call(path, { method = "GET", body } = {}) {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: "application/json",
        // Jira answers in the token owner's profile language; ask for English so
        // a failure is legible to whoever pressed the button.
        "accept-language": "en-US,en;q=0.9",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new Error(
        `jira ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`,
      );
    return res.status === 204 ? null : res.json().catch(() => null);
  };
}

// Jira hides email addresses under some privacy settings, in which case the
// service user stays the reporter — an issue with the wrong reporter beats no
// issue at all.
export async function findAccountId(jira, email) {
  if (!email) return null;
  const users = await jira(
    `/rest/api/3/user/search?query=${encodeURIComponent(email)}`,
  ).catch(() => null);
  const match = (users ?? []).find(
    (u) => u?.emailAddress?.toLowerCase() === email.toLowerCase(),
  );
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
        {
          type: "text",
          text: "View the Slack thread",
          marks: [{ type: "link", attrs: { href: threadUrl } }],
        },
      ],
    });
  }

  return { type: "doc", version: 1, content };
}

// Transitions are matched by destination status name: a transition id is
// per-workflow and changes when the board is edited, and the wrong one fails as
// an opaque 400. Throws with what WAS available, so the Slack error is legible.
export async function transitionTo(jira, key, statusName) {
  const want = String(statusName).toLowerCase();
  const { transitions = [] } =
    (await jira(`/rest/api/3/issue/${key}/transitions`)) ?? {};
  const match = transitions.find((t) => t.to?.name?.toLowerCase() === want);

  if (match) {
    await jira(`/rest/api/3/issue/${key}/transitions`, {
      method: "POST",
      body: { transition: { id: match.id } },
    });
    return;
  }

  // No transition to it can also mean it is already there — two people pressing
  // at once, or a retry after a partial failure. Both should be quiet no-ops.
  const issue = await jira(`/rest/api/3/issue/${key}?fields=status`);
  if (issue?.fields?.status?.name?.toLowerCase() === want) return;

  const available =
    transitions
      .map((t) => t.to?.name)
      .filter(Boolean)
      .join(", ") || "none";
  throw new Error(
    `${key}: no transition to "${statusName}" from ${issue?.fields?.status?.name ?? "its current status"} (available: ${available})`,
  );
}
