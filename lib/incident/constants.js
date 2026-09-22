// Shared constants: INCY field ids, the workflow statuses and the emoji.

// Field ids from the project's create metadata. Custom fields cannot be set
// through Slack's own Jira Cloud step, which is why this app exists.
export const JIRA = {
  project: "INCY",
  issueType: "10821",
  slack: "customfield_12729",
  // Jira calls this field "Incident report". Dusty writes it today, after it
  // drafts the post-mortem; kept here for when this app sets it directly.
  postmortem: "customfield_12724",
};

// Timestamps (started, mitigated, resolved) are Jira automations' job, not
// ours: they fire on the transition. Severity is no longer on the screen at
// all, and asking for it up front is the friction that stops people raising
// incidents in the first place.

// Where the buttons move an incident to, as destination STATUS ids: a rename on
// the board leaves these alone. Never transition ids — those are per-workflow
// and change silently when the board is edited.
export const STATUS = { open: "11985", mitigated: "11987", resolved: "11986" };

export const LABEL = { open: "Open", mitigated: "Mitigated", resolved: "Resolved" };

// In the messages.
export const EMOJI = {
  open: "x",
  mitigated: "large_orange_circle",
  resolved: "white_check_mark",
};

// On the triage message. Open reads as "live", so it keeps the siren the
// incident was raised with rather than the :x: the revert message carries.
export const REACTION = {
  open: "rotating_light",
  mitigated: "large_orange_circle",
  resolved: "white_check_mark",
};

export const SLACK_TIMEOUT_MS = 5000;
export const JIRA_TIMEOUT_MS = 10000;
