// What each interaction does: raise, change status, ask Dusty for the report.

import { codeName, incidentName } from "./codename.js";
import {
  CHANNEL_LOOKUP_TIMEOUT_MS,
  JIRA,
  LABEL,
  REACTION,
  STATUS,
} from "./constants.js";
import {
  browseUrl,
  findAccountId,
  incidentDescription,
  transitionTo,
} from "./jira.js";
import {
  createdBlocks,
  draftReportPrompt,
  encodeRef,
  stripActions,
  statusChannelText,
  statusThreadBlocks,
  thanksBlocks,
  threadBlocks,
  triageText,
} from "./blocks.js";
import { postResponse, slackGet, soft } from "./slack.js";

// A press is locked only while it is in flight, and released either way. On
// failure the buttons are still there, the error says why, and pressing again
// retries. On success the buttons are removed instead — that, not a timer, is
// what stops a second press.
const inFlight = new Set();

async function once(key, fn) {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await fn();
  } finally {
    inFlight.delete(key);
  }
}

// Slack hands back the pressed message's own blocks, so this is that message
// minus anything clickable.
async function removeButtons({ slack, source }) {
  if (!source?.ts) return;
  await slack("chat.update", {
    channel: source.channel,
    ts: source.ts,
    text: source.text || " ",
    blocks: stripActions(source.blocks),
  });
}

function replyTo(thread, dedicated) {
  return dedicated ? {} : { thread_ts: thread };
}

export async function lookupChannel({ channelId, channelName, deps }) {
  if (!channelId || channelId.startsWith("D") || channelName?.startsWith("mpdm-"))
    return null;

  const info = await soft(() =>
    slackGet(
      "conversations.info",
      { channel: channelId },
      deps.botToken,
      CHANNEL_LOOKUP_TIMEOUT_MS,
    ),
  );
  const c = info?.channel;
  const postable = Boolean(
    c &&
      (c.is_channel || c.is_group) &&
      !c.is_mpim &&
      !c.is_archived &&
      (!c.is_private || c.is_member),
  );
  return { id: channelId, name: c?.name ?? null, postable };
}

async function triageChannel({ destination, origin, channelName, user, deps }) {
  if (destination === "dedicated") {
    const { channel } = await deps.slack("conversations.create", {
      name: channelName,
      is_private: true,
    });
    await deps.slack("conversations.invite", { channel: channel.id, users: user });
    return channel.id;
  }
  if (destination === "current" && origin?.postable) return origin.id;
  return deps.channel;
}

export async function openIncident({
  summary,
  destination,
  origin,
  user,
  responseUrl,
  deps,
}) {
  const { slack, jira, botToken, jiraBaseUrl, postmortemsUrl } = deps;
  const dedicated = destination === "dedicated";
  const code = dedicated ? codeName() : null;

  const profile = await soft(() => slackGet("users.info", { user }, botToken));
  const who =
    profile?.user?.profile?.real_name || profile?.user?.name || "someone";
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
        summary: code ? incidentName(code) : summary,
        description: incidentDescription({ who, channel: origin?.name }),
        ...(reporterId ? { reporter: { id: reporterId } } : {}),
      },
    },
  });

  const key = created.key;
  const issueUrl = browseUrl(jiraBaseUrl, key);
  const channelName = dedicated ? `${key.toLowerCase()}-${code}` : null;
  const channel = await triageChannel({ destination, origin, channelName, user, deps });

  const posted = await slack("chat.postMessage", {
    channel,
    text: triageText({ key, summary, dedicated }),
    unfurl_links: false,
  });
  const ts = posted.ts;
  const ref = encodeRef({ key, channel, thread: ts, reporter: user, dedicated });

  // Posting into a public channel needs no membership, but reactions and pins do.
  await soft(() => slack("conversations.join", { channel }));
  await soft(() =>
    slack("reactions.add", { channel, timestamp: ts, name: REACTION.open }),
  );
  await soft(() => slack("pins.add", { channel, timestamp: ts }));

  const permalink = await soft(() =>
    slackGet("chat.getPermalink", { channel, message_ts: ts }, botToken),
  );
  const threadUrl = permalink?.permalink ?? "";

  if (threadUrl) {
    await soft(() =>
      jira(`/rest/api/3/issue/${key}`, {
        method: "PUT",
        body: { fields: { [JIRA.slack]: threadUrl } },
      }),
    );
  }

  await soft(() =>
    slack("chat.postMessage", {
      channel,
      ...replyTo(ts, dedicated),
      text: `${key} raised`,
      blocks: threadBlocks({ key, url: issueUrl, reporter: user, ref, dedicated }),
    }),
  );

  await respond({
    deps,
    responseUrl,
    user,
    text: `Created incident ${key}`,
    blocks: createdBlocks({ key, channel, threadUrl, dedicated }),
  });

  return { key, ts, threadUrl, issueUrl, postmortemsUrl };
}

// Answer where they were, not where the incident lives. response_url reaches
// the originating channel even one this bot has never joined; a DM is the
// fallback when the url is missing or has expired.
export async function respond({ deps, responseUrl, user, text, blocks }) {
  if (responseUrl) {
    try {
      await postResponse(responseUrl, { text, blocks });
      return;
    } catch {
      // Expired, or Slack rejected it — fall through to a DM.
    }
  }
  await soft(() => deps.slack("chat.postMessage", { channel: user, text, blocks }));
}

export async function markStatus({ status, ref, source, user, deps }) {
  const { slack, jira, botToken, jiraBaseUrl } = deps;
  const { key, channel, thread, reporter, dedicated } = ref;

  await once(`${key}:status`, async () => {
    // Jira first. Timestamps are left to the automations that fire on this
    // transition — writing them here would only race with them.
    await transitionTo(jira, key, STATUS[status], LABEL[status]);

    await soft(() => removeButtons({ slack, source }));

    const profile = await soft(() => slackGet("users.info", { user }, botToken));
    const who =
      profile?.user?.profile?.real_name || profile?.user?.name || "someone";

    // Pinned while it is live, unpinned once it is not.
    await soft(() =>
      slack(status === "open" ? "pins.add" : "pins.remove", {
        channel,
        timestamp: thread,
      }),
    );

    // Clear every status reaction rather than the one we assume is there: the
    // incident may have arrived here from any of the others.
    for (const name of new Set(Object.values(REACTION))) {
      if (name === REACTION[status]) continue;
      await soft(() => slack("reactions.remove", { channel, timestamp: thread, name }));
    }
    await soft(() =>
      slack("reactions.add", { channel, timestamp: thread, name: REACTION[status] }),
    );

    const issueUrl = browseUrl(jiraBaseUrl, key);
    const nextRef = encodeRef({ key, channel, thread, reporter, dedicated });

    // Only resolution is worth a message in the channel proper. Mitigating and
    // reverting are working updates and belong where the work is.
    if (status === "resolved" && !dedicated) {
      await soft(() =>
        slack("chat.postMessage", {
          channel,
          text: statusChannelText({ key, status, who }),
          unfurl_links: false,
        }),
      );
    }
    await soft(() =>
      slack("chat.postMessage", {
        channel,
        ...replyTo(thread, dedicated),
        text: statusChannelText({ key, status, who }),
        blocks: statusThreadBlocks({
          key,
          url: issueUrl,
          status,
          who,
          ref: nextRef,
        }),
      }),
    );
  });
}

// Skip: the incident is resolved and nobody wants a draft. Nothing to record —
// just stop offering.
export async function dismissButtons({ source, deps }) {
  await soft(() => removeButtons({ slack: deps.slack, source }));
}

export async function requestReport({ ref, source, user, deps }) {
  const { slack, botToken, dustyUserId, jiraBaseUrl, postmortemsUrl } = deps;
  const { key, channel, thread, reporter, dedicated } = ref;

  await once(`${key}:report`, async () => {
    await slack("chat.postMessage", {
      channel,
      ...replyTo(thread, dedicated),
      text: draftReportPrompt({ dustyUserId, key, requester: user, dedicated }),
      unfurl_links: false,
    });

    await soft(() => removeButtons({ slack, source }));

    const permalink = await soft(() =>
      slackGet("chat.getPermalink", { channel, message_ts: thread }, botToken),
    );

    await soft(() =>
      slack("chat.postMessage", {
        channel: reporter ?? user,
        text: `Thanks for reporting ${key} :sparkles:`,
        blocks: thanksBlocks({
          key,
          threadUrl: permalink?.permalink ?? null,
          issueUrl: browseUrl(jiraBaseUrl, key),
          reportUrl: postmortemsUrl,
          dedicated,
        }),
      }),
    );
  });
}
