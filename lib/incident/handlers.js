// What each interaction does: raise, change status, ask Dusty for the report.

import { ALERT_EMOJI, DONE_EMOJI, JIRA, LABEL, STATUS } from "./constants.js";
import { browseUrl, findAccountId, incidentDescription, jiraTimestamp, transitionTo } from "./jira.js";
import {
  draftReportPrompt,
  encodeRef,
  statusChannelText,
  statusThreadBlocks,
  thanksBlocks,
  threadBlocks,
  triageText,
} from "./blocks.js";
import { slackGet, soft } from "./slack.js";

// Two people pressing Resolved at once should not post twice. Reactions, pins
// and the summary rename are all idempotent; the messages are not.
const SEEN_TTL_MS = 10 * 60 * 1000;
const seen = new Map();
export function alreadySeen(id, now = Date.now()) {
  if (!id) return false;
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now + SEEN_TTL_MS);
  return false;
}

export async function openIncident({ summary, user, deps }) {
  const { slack, jira, botToken, channel, jiraBaseUrl, postmortemsUrl } = deps;

  const profile = await soft(() => slackGet("users.info", { user }, botToken));
  const who = profile?.user?.profile?.real_name || profile?.user?.name || "someone";
  const email = profile?.user?.profile?.email ?? null;

  // Reporter is the Slack user matched on their Healthengine email. When Jira
  // hides emails, or they have no Atlassian account, the issue falls back to
  // whoever the API token belongs to — Healthengine Automations.
  const reporterId = await findAccountId(jira, email);
  const created = await jira("/rest/api/3/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: JIRA.project },
        issuetype: { id: JIRA.issueType },
        summary,
        description: incidentDescription({ who }),
        ...(reporterId ? { reporter: { id: reporterId } } : {}),
      },
    },
  });

  const key = created.key;
  const issueUrl = browseUrl(jiraBaseUrl, key);

  const posted = await slack("chat.postMessage", {
    channel,
    text: triageText({ key, url: issueUrl, summary }),
    unfurl_links: false,
  });
  const ts = posted.ts;
  const ref = encodeRef({ key, channel, thread: ts, reporter: user });

  // Posting into a public channel needs no membership, but reactions and pins do.
  await soft(() => slack("conversations.join", { channel }));
  await soft(() => slack("reactions.add", { channel, timestamp: ts, name: ALERT_EMOJI }));
  await soft(() => slack("pins.add", { channel, timestamp: ts }));

  const permalink = await soft(() => slackGet("chat.getPermalink", { channel, message_ts: ts }, botToken));
  const threadUrl = permalink?.permalink ?? "";

  // The thread has its own field now; the description carries the same link
  // for anyone who opens the issue before the field.
  if (threadUrl) {
    await soft(() =>
      jira(`/rest/api/3/issue/${key}`, {
        method: "PUT",
        body: { fields: { [JIRA.slack]: threadUrl, description: incidentDescription({ who, threadUrl }) } },
      }),
    );
  }

  await soft(() =>
    slack("chat.postMessage", {
      channel,
      thread_ts: ts,
      text: `${key} raised`,
      blocks: threadBlocks({ key, url: issueUrl, reporter: user, ref }),
    }),
  );

  await tellUser({
    deps,
    channel,
    user,
    text: `:rotating_light: Created incident *${key}* in <#${channel}>\n${threadUrl}`,
  });

  return { key, ts, threadUrl, issueUrl, postmortemsUrl };
}

// Ephemeral needs the user to be in the channel; a DM always lands. Try the
// quieter one first.
export async function tellUser({ deps, channel, user, text, blocks }) {
  const { slack } = deps;
  const ephemeral = await soft(() => slack("chat.postEphemeral", { channel, user, text, blocks }));
  if (ephemeral) return;
  await soft(() => slack("chat.postMessage", { channel: user, text, blocks }));
}

export async function markStatus({ status, ref, user, deps }) {
  const { slack, jira, botToken, jiraBaseUrl } = deps;
  const { key, channel, thread, reporter } = ref;

  if (alreadySeen(`${key}:${status}`)) return;

  const profile = await soft(() => slackGet("users.info", { user }, botToken));
  const who = profile?.user?.profile?.real_name || profile?.user?.name || "someone";

  await soft(() => slack("pins.remove", { channel, timestamp: thread }));
  await soft(() => slack("reactions.remove", { channel, timestamp: thread, name: ALERT_EMOJI }));
  await soft(() => slack("reactions.add", { channel, timestamp: thread, name: DONE_EMOJI }));

  const stamp = jiraTimestamp();
  const fields = { [status === "resolved" ? JIRA.resolved : JIRA.mitigated]: stamp };

  // A short incident often goes straight to Resolved. Without this, its
  // time-to-mitigate is empty forever — so fill the gap, never overwrite a
  // mitigation time someone already recorded.
  if (status === "resolved") {
    const current = await jira(`/rest/api/3/issue/${key}?fields=${JIRA.mitigated}`);
    if (!current?.fields?.[JIRA.mitigated]) fields[JIRA.mitigated] = stamp;
  }

  // Timestamp first: an automation firing on the transition should see it set.
  await jira(`/rest/api/3/issue/${key}`, { method: "PUT", body: { fields } });
  await transitionTo(jira, key, STATUS[status]);

  const issueUrl = browseUrl(jiraBaseUrl, key);
  const nextRef = encodeRef({ key, channel, thread, reporter });

  await soft(() => slack("chat.postMessage", { channel, text: statusChannelText({ key, status, who }), unfurl_links: false }));
  await soft(() =>
    slack("chat.postMessage", {
      channel,
      thread_ts: thread,
      text: `${key} marked as ${LABEL[status]}`,
      blocks: statusThreadBlocks({ key, url: issueUrl, status, who, ref: nextRef }),
    }),
  );
}

export async function requestReport({ ref, user, deps }) {
  const { slack, botToken, dustyUserId, jiraBaseUrl, postmortemsUrl } = deps;
  const { key, channel, thread, reporter } = ref;

  if (alreadySeen(`${key}:report`)) return;

  await slack("chat.postMessage", {
    channel,
    thread_ts: thread,
    text: draftReportPrompt({ dustyUserId, key, requester: user }),
    unfurl_links: false,
  });

  const permalink = await soft(() => slackGet("chat.getPermalink", { channel, message_ts: thread }, botToken));
  const target = reporter ?? user;

  await soft(() =>
    slack("chat.postMessage", {
      channel: target,
      text: `Thanks for reporting ${key} :sparkles:`,
      blocks: thanksBlocks({
        key,
        threadUrl: permalink?.permalink ?? browseUrl(jiraBaseUrl, key),
        issueUrl: browseUrl(jiraBaseUrl, key),
        reportUrl: postmortemsUrl,
      }),
    }),
  );
}
