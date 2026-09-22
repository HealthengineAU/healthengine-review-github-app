// Slack surfaces: the modal, the messages and the buttons. Pure — no IO.

import { EMOJI, LABEL } from "./constants.js";

// Slack refuses to open a view whose initial_value exceeds max_length, so
// the two have to agree.
const SUMMARY_MAX = 120;

// Button payloads are capped at 2000 chars, so the keys stay short.
export function encodeRef({ key, channel, thread, reporter }) {
  return JSON.stringify({ k: key, c: channel, t: thread, r: reporter });
}

export function decodeRef(raw) {
  try {
    const v = JSON.parse(raw);
    if (!v?.k || !v?.c || !v?.t) return null;
    return { key: v.k, channel: v.c, thread: v.t, reporter: v.r ?? null };
  } catch {
    return null;
  }
}

// A slash command knows which channel it was typed in; a view_submission does
// not. Slack's response_url is the only thing that gets an answer back to that
// channel, so it rides through the modal in private_metadata.
// With should_escape on, Slack hands us markup rather than what was typed:
// <#C1|bookings>, <@U1|ann>, <!here>, <!subteam^S1|@platform>, <https://x|docs>.
// A Jira summary wants the display value, so unwrap each to the label a human
// saw and fall back to the raw reference when Slack sends no label.
export function unescapeSlackText(text) {
  return String(text ?? "")
    .replace(/<([^>]+)>/g, (_whole, inner) => {
      const [ref, label] = inner.split("|");
      if (ref.startsWith("!subteam^")) return label || "@team";
      if (ref.startsWith("!")) return `@${ref.slice(1)}`;
      if (ref.startsWith("#") || ref.startsWith("@")) {
        return label ? `${ref[0]}${label}` : ref;
      }
      return label || ref;
    })
    // Entities last: doing this first would turn &lt; into a < the parser above
    // would then mistake for markup.
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Anything typed after the command becomes the summary, so `/incident the
// booking form has exploded` opens the form already filled in. Only the
// first letter is touched: acronyms and product names have to survive.
export function prefillSummary(text) {
  const trimmed = unescapeSlackText(text).trim().slice(0, SUMMARY_MAX);
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : "";
}

export function incidentModal({ responseUrl, text } = {}) {
  const summary = prefillSummary(text);

  return {
    type: "modal",
    callback_id: "incident_create",
    private_metadata: JSON.stringify({ responseUrl: responseUrl ?? null }),
    title: { type: "plain_text", text: "Start an incident" },
    submit: { type: "plain_text", text: "Start" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "summary",
        label: { type: "plain_text", text: "What's going on?" },
        hint: {
          type: "plain_text",
          text: "5-10 words. Everything else goes in the thread.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: SUMMARY_MAX,
          ...(summary ? { initial_value: summary } : {}),
          placeholder: {
            type: "plain_text",
            text: "Search currently unavailable for some users",
          },
        },
      },
    ],
  };
}

export function summaryFromView(view) {
  const raw = view?.state?.values?.summary?.value?.value;
  return typeof raw === "string" ? raw.trim() : "";
}

export function triageText({ key, url, summary }) {
  return `*Incident <${url}|${key}>* - ${summary} - thread :thread:`;
}

// The permalink as a button, not a bare URL: Slack unfurls a bare permalink
// into several lines of preview inside a message that should be one.
export function createdBlocks({ key, channel, threadUrl }) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Created incident *${key}* in <#${channel}>`,
      },
    },
  ];

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "incident_dismiss",
        text: { type: "plain_text", text: "Dismiss" },
      },
      // getPermalink is best-effort, so this one has to be able to not be here.
      ...(threadUrl
        ? [
            {
              type: "button",
              action_id: "incident_view_thread",
              style: "primary",
              text: { type: "plain_text", text: `View ${key} thread` },
              url: threadUrl,
            },
          ]
        : []),
    ],
  });

  return blocks;
}

export function threadBlocks({ key, url, reporter, ref }) {
  const text = [
    `:jira: *<${url}|${key}>*`,
    `Raised by <@${reporter}>`,
    "",
    "Share any relevant links (e.g. Slack, GitHub) in this thread.",
    "",
    "Mark as mitigated when the immediate impact or disruption has been addressed.",
  ].join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", block_id: "incident_status", elements: statusButtons("open", ref) },
  ];
}

// What can be done next, given where the incident is now. Open offers only
// mitigation; resolving is the step after it, not an alternative to it.
function statusButtons(status, ref) {
  const button = (action_id, text, style) => ({
    type: "button",
    action_id,
    ...(style ? { style } : {}),
    text: { type: "plain_text", text },
    value: ref,
  });

  if (status === "mitigated") {
    return [
      button("incident_reopen", "Revert", "danger"),
      button("incident_resolved", "Mark as resolved", "primary"),
    ];
  }
  if (status === "resolved") {
    return [
      button("incident_draft_report", "@Dusty - Draft incident report", "primary"),
      button("incident_skip_report", "Skip"),
    ];
  }
  return [button("incident_mitigated", "Mark as mitigated", "primary")];
}

// "reverted to" rather than "marked as": a revert is a correction, and reading
// it as just another status change hides that.
function statusLine(status) {
  return status === "open" ? "reverted to" : "marked as";
}

export function statusChannelText({ key, status, who }) {
  return `:${EMOJI[status]}: *${key}* ${statusLine(status)} *${LABEL[status]}* by ${who}`;
}

export function statusThreadBlocks({ key, url, status, who, ref }) {
  const lines = [
    `:${EMOJI[status]}: *<${url}|${key}>* ${statusLine(status)} *${LABEL[status]}* by ${who}`,
  ];
  if (status === "resolved") {
    lines.push("", "_Incident will auto-close once incident report is attached_");
  }

  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "actions", block_id: "incident_status", elements: statusButtons(status, ref) },
  ];
}

// Dusty is tagged first and the requester second: Dusty's proxy takes the first
// NON-Dusty mention as the session's actor, and ignores a message that tags
// nobody but itself.
export function draftReportPrompt({ dustyUserId, key, requester }) {
  return (
    `<@${dustyUserId}> draft an incident report (only if one doesn't already exist). ` +
    `See thread for details. Requested by <@${requester}>. ` +
    `Set the 'Incident report' url in ${key}. Reply with report link.`
  );
}

export function thanksBlocks({ key, threadUrl, issueUrl, reportUrl }) {
  const buttons = [
    // Dropped rather than pointed elsewhere: a button called View thread that
    // opens Jira is worse than no button.
    threadUrl ? { text: "View thread", url: threadUrl } : null,
    reportUrl ? { text: "Create incident report", url: reportUrl } : null,
    { text: "Edit incident", url: issueUrl },
  ].filter(Boolean);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Thanks for reporting *${key}* :sparkles:`,
      },
    },
    {
      type: "actions",
      elements: buttons.map((b, i) => ({
        type: "button",
        action_id: `incident_link_${i}`,
        text: { type: "plain_text", text: b.text },
        url: b.url,
      })),
    },
  ];
}

export function viewResponseUrl(view) {
  try {
    return JSON.parse(view?.private_metadata || "{}").responseUrl || null;
  } catch {
    return null;
  }
}

// A button that has been pressed should stop being a button. Slack hands the
// message's own blocks back on every block_actions, so the update is the
// original message minus whatever was clickable.
export function stripActions(blocks) {
  return (blocks ?? []).filter((b) => b.type !== "actions");
}
