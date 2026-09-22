// Shared constants: INCY field ids, the workflow statuses and the emoji.

// Field ids from the project's create metadata. Custom fields cannot be set
// through Slack's own Jira Cloud step, which is why this app exists.
export const JIRA = {
  project: "INCY",
  issueType: "10821",
  report: "customfield_12724",
  slack: "customfield_12729",
  started: "customfield_12727",
  mitigated: "customfield_12730",
  resolved: "customfield_12728",
};

// Incident started defaults to creation time, and severity is no longer on the
// screen at all. Neither is asked for up front: that question is the friction
// that stops people raising incidents in the first place.

// Where the buttons move an incident to. Matched by destination status NAME at
// runtime, never by transition id — ids are per-workflow and change silently
// when the board is edited.
export const STATUS = { mitigated: "Impact mitigated", resolved: "Resolved" };

export const LABEL = { mitigated: "Mitigated", resolved: "Resolved" };

export const ALERT_EMOJI = "alert";
export const DONE_EMOJI = "white_check_mark";

export const SLACK_TIMEOUT_MS = 5000;
export const JIRA_TIMEOUT_MS = 10000;
