// Slack surfaces: the modal, the messages and the buttons. Pure — no IO.

import { DONE_EMOJI, LABEL } from "./constants.js";

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

export function incidentModal() {
  return {
    type: "modal",
    callback_id: "incident_create",
    title: { type: "plain_text", text: "Start an incident" },
    submit: { type: "plain_text", text: "Raise incident" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "summary",
        label: { type: "plain_text", text: "What's going on?" },
        hint: { type: "plain_text", text: "5-10 words. Everything else goes in the thread." },
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: 120,
          placeholder: { type: "plain_text", text: "Bookings failing for some practices" },
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
  return `*Incident <${url}|${key}> raised* - ${summary} - please reply in thread :thread:`;
}

export function threadBlocks({ key, url, reporter, ref }) {
  const text = [
    `:jira: <${url}|${key}>`,
    `Reported by <@${reporter}>`,
    "",
    "Share any relevant links (e.g. Slack, GitHub) in this thread.",
    "",
    "Click on *Mitigated* or *Resolved* when ready to update the status of the incident.",
  ].join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: "incident_status",
      elements: [
        { type: "button", action_id: "incident_mitigated", text: { type: "plain_text", text: "Mark as mitigated" }, value: ref },
        { type: "button", action_id: "incident_resolved", style: "primary", text: { type: "plain_text", text: "Mark as resolved" }, value: ref },
      ],
    },
  ];
}

export function statusChannelText({ key, status, who }) {
  return `:${DONE_EMOJI}: *${key}* marked as *${LABEL[status]}* by ${who}`;
}

export function statusThreadBlocks({ key, url, status, who, ref }) {
  const text = [
    `*<${url}|${key}>* marked as *${LABEL[status]}* by ${who}`,
    "",
    "_Incident will auto-close once Resolved and Incident report is attached_",
  ].join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: "incident_report",
      elements: [
        {
          type: "button",
          action_id: "incident_draft_report",
          text: { type: "plain_text", text: "@Dusty - Draft incident report" },
          value: ref,
        },
      ],
    },
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
    { text: "View thread", url: threadUrl },
    reportUrl ? { text: "Create incident report", url: reportUrl } : null,
    { text: "Edit incident", url: issueUrl },
  ].filter(Boolean);

  return [
    { type: "section", text: { type: "mrkdwn", text: `Thanks for reporting *${key}* :sparkles:` } },
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
