// A /incident slash command: one short form, one Jira issue, one triage thread.
//
// This is a SECOND Slack app, not Dusty's. The "Draft incident report" button
// tags @Dusty, and Dusty's proxy drops mentions authored by its own app — so
// this needs its own signing secret and bot token, and its app_id belongs in
// the sidecar's SLACK_ALLOWED_BOT_APPS for those mentions to be honoured.
//
// Nothing is stored. Every button carries the issue key, channel and thread it
// acts on, so a restart loses nothing and a redelivery is harmless.
//
// Slack payloads are untrusted DATA carried through to Jira, never instructions.
// The signature check is the only thing that authenticates a caller.

import {
  decodeRef,
  incidentModal,
  summaryFromView,
  viewResponseUrl,
} from "./blocks.js";
import {
  markStatus,
  openIncident,
  requestReport,
  respond,
} from "./handlers.js";
import { jiraClient } from "./jira.js";
import { rawBody, slackCall, verifySlackSignature } from "./slack.js";

export function register(app, { getRouter } = {}) {
  if (typeof getRouter !== "function") {
    app?.log?.warn?.(
      "[incident] no router available - /slack/incident not mounted",
    );
    return;
  }

  const signingSecret = process.env.INCIDENT_SLACK_SIGNING_SECRET;
  const botToken = process.env.INCIDENT_SLACK_BOT_TOKEN;
  const channel = process.env.INCIDENT_CHANNEL_ID;
  const dustyUserId = process.env.INCIDENT_DUSTY_USER_ID;
  const jiraBaseUrl = process.env.INCIDENT_JIRA_BASE_URL;
  const jiraEmail = process.env.INCIDENT_JIRA_EMAIL;
  const jiraToken = process.env.INCIDENT_JIRA_API_TOKEN;
  const jiraCloudId = process.env.INCIDENT_JIRA_CLOUD_ID;
  const postmortemsUrl = process.env.INCIDENT_POSTMORTEMS_URL || null;

  // Better to have no /incident than one that takes a summary and drops it:
  // the failure would land mid-incident, on someone with other problems.
  const missing = Object.entries({
    INCIDENT_SLACK_SIGNING_SECRET: signingSecret,
    INCIDENT_SLACK_BOT_TOKEN: botToken,
    INCIDENT_CHANNEL_ID: channel,
    INCIDENT_DUSTY_USER_ID: dustyUserId,
    INCIDENT_JIRA_BASE_URL: jiraBaseUrl,
    INCIDENT_JIRA_CLOUD_ID: jiraCloudId,
    INCIDENT_JIRA_EMAIL: jiraEmail,
    INCIDENT_JIRA_API_TOKEN: jiraToken,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    app?.log?.warn?.(`[incident] not mounted - missing ${missing.join(", ")}`);
    return;
  }

  const jira = jiraClient({ email: jiraEmail, token: jiraToken, cloudId: jiraCloudId });

  const deps = {
    slack: (method, body) => slackCall(method, body, botToken),
    jira,
    botToken,
    channel,
    dustyUserId,
    jiraBaseUrl,
    postmortemsUrl,
  };

  const router = getRouter();

  function verified(req, res) {
    if (
      !verifySlackSignature({
        signingSecret,
        timestamp: req.headers["x-slack-request-timestamp"],
        rawBody: req.rawBody ?? "",
        signature: req.headers["x-slack-signature"],
      })
    ) {
      res.status(401).send("bad signature");
      return false;
    }
    return true;
  }

  // /incident - open the form. trigger_id dies after 3s, so the ack goes first
  // and views.open follows immediately.
  router.post("/slack/incident/command", rawBody, async (req, res) => {
    if (!verified(req, res)) return;
    res.status(200).send();

    const body = new URLSearchParams(req.rawBody ?? "");
    const triggerId = body.get("trigger_id");
    if (!triggerId) return;

    try {
      const view = incidentModal({
        responseUrl: body.get("response_url"),
        text: body.get("text"),
      });
      await deps.slack("views.open", { trigger_id: triggerId, view });
    } catch (err) {
      console.error("[incident] views.open failed:", err.message);
    }
  });

  // Modal submits and button presses. An empty 200 closes the modal; the work
  // that follows can outlive Slack's 3s budget.
  router.post("/slack/incident/interact", rawBody, async (req, res) => {
    if (!verified(req, res)) return;
    res.status(200).send();

    let payload;
    try {
      payload = JSON.parse(
        new URLSearchParams(req.rawBody ?? "").get("payload") ?? "{}",
      );
    } catch {
      return;
    }

    const user = payload?.user?.id;
    if (!user) return;

    // A button carries its own response_url; a modal carries the command's.
    const responseUrl = payload.response_url ?? viewResponseUrl(payload.view);

    try {
      if (
        payload.type === "view_submission" &&
        payload.view?.callback_id === "incident_create"
      ) {
        const summary = summaryFromView(payload.view);
        if (!summary) return;
        await openIncident({ summary, user, responseUrl, deps });
        return;
      }

      if (payload.type === "block_actions") {
        const action = payload.actions?.[0];
        const ref = decodeRef(action?.value);
        if (!ref) return;

        const source = {
          channel: payload.container?.channel_id ?? ref.channel,
          ts: payload.container?.message_ts,
          blocks: payload.message?.blocks,
          text: payload.message?.text,
        };

        if (action.action_id === "incident_mitigated")
          return void (await markStatus({
            status: "mitigated",
            ref,
            source,
            user,
            deps,
          }));
        if (action.action_id === "incident_resolved")
          return void (await markStatus({
            status: "resolved",
            ref,
            source,
            user,
            deps,
          }));
        if (action.action_id === "incident_draft_report")
          return void (await requestReport({ ref, source, user, deps }));
      }
    } catch (err) {
      console.error("[incident] handler failed:", err.message);
      // Silence here would look like success. Tell whoever pressed the button.
      await respond({
        deps,
        responseUrl,
        user,
        text: `:warning: That didn't work: ${err.message}`,
      });
    }
  });
}
