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

// Basic auth (email:token) against the api.atlassian.com gateway — not the site
// URL, which rejects a scoped token. The site URL is for browse/ links only.
export function jiraClient({ email, token, cloudId }) {
  if (!cloudId) throw new Error("jiraClient: cloudId is required");
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

// Jira's REST v3 takes ADF, so even one plain sentence has to be built. The
// Slack thread is not linked here — the Incident Slack field holds it.
export function incidentDescription({ who }) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `Raised via Slack by ${who}` }],
      },
    ],
  };
}

// Matched by destination status id: a rename in Jira leaves the id alone, and a
// transition id is per-workflow and changes when the board is edited — the wrong
// one fails as an opaque 400. The label is only ever read back in the error, and
// is the one off the button rather than Jira's internal name, so whoever pressed
// it reads what they pressed. Throws with what WAS available.
export async function transitionTo(jira, key, statusId, label) {
  const { transitions = [] } =
    (await jira(`/rest/api/3/issue/${key}/transitions`)) ?? {};
  const match = transitions.find((t) => t.to?.id === statusId);

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
  if (issue?.fields?.status?.id === statusId) return;

  const available =
    transitions
      .map((t) => t.to?.name)
      .filter(Boolean)
      .join(", ") || "none";
  throw new Error(
    `${key}: no transition to "${label}" from ${issue?.fields?.status?.name ?? "its current status"} (available: ${available})`,
  );
}
