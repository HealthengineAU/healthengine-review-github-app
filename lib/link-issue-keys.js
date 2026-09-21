// Injects a link to the issue a pull request is for into its description, when
// the branch name or title names one and the description doesn't.
//
// A tracker that auto-links keys found in a description (Jira's GitHub
// integration, for one) can only do that when the key is actually there, so a
// branch like `abc-123-bearer-tokens` whose description never says "ABC-123"
// gets a link line added above the existing text.
//
// OPT-IN: nothing fires unless `issue_links.automatic` is true and
// `issue_links.rules` says which keys to look for and where each one points
// (see config.js). Rules are also what keeps `node-21` from looking like an
// issue — a key no rule claims is never linked.

import { loadAiReviewConfig } from "./config.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

// A KEY-123 token: the key starts on a boundary and runs to the first
// "-<digits>", so it can span hyphens ("some-thing-220"). A version-style
// ".4" after the number rules it out, so "core-app-1.2.328" and "joi-17.13.8"
// aren't issues; a trailing letter is a sub-branch marker ("ABC-284a") and
// isn't part of the reference.
const REFERENCE = /(?<![A-Za-z0-9-])([A-Za-z][A-Za-z0-9-]*?)-(\d+)(?!\.?\d)/g;

// The keys a matched run could be, most specific first, so a rule for
// "some-thing" wins over one for "thing" where both are configured.
function keyCandidates(run) {
  const segments = run.split("-");
  return segments
    .map((_, index) => segments.slice(index).join("-"))
    .filter((candidate) => /^[A-Za-z]/.test(candidate));
}

// $KEY / $key / $NUMBER in a rule's `label` and `url` templates.
function fillTemplate(template, key, number) {
  return template
    .replaceAll("$KEY", key.toUpperCase())
    .replaceAll("$key", key.toLowerCase())
    .replaceAll("$NUMBER", number);
}

// Every reference in `text` claimed by a rule, deduped, in the order they
// appear. The longest key a rule claims wins; between rules, the first.
export function extractReferences(text, rules) {
  const references = [];
  if (typeof text !== "string") return references;

  for (const [, run, number] of text.matchAll(REFERENCE)) {
    let key;
    let rule;
    for (const candidate of keyCandidates(run)) {
      rule = rules.find(({ keys }) => matchesFilterPatterns(keys, candidate));
      if (rule) {
        key = candidate;
        break;
      }
    }
    if (!rule) continue;

    const reference = {
      token: `${key.toUpperCase()}-${number}`,
      label: fillTemplate(rule.label, key, number),
      url: fillTemplate(rule.url, key, number),
    };
    if (!references.some((seen) => seen.url === reference.url)) {
      references.push(reference);
    }
  }
  return references;
}

// Does the description already point at this issue — as a key the tracker will
// auto-link, or as the link itself? Either way we leave it alone.
export function mentionsReference(body, { token, url }) {
  if (typeof body !== "string") return false;
  if (body.includes(url)) return true;
  return new RegExp(`(?<![A-Za-z0-9])${token}(?![A-Za-z0-9])`, "i").test(body);
}

// The references named by the branch or title that the description is missing.
export function missingReferences({ branch, title, body, rules }) {
  const named = [...extractReferences(branch, rules), ...extractReferences(title, rules)];
  const missing = [];
  for (const reference of named) {
    if (mentionsReference(body, reference)) continue;
    if (missing.some((seen) => seen.url === reference.url)) continue;
    missing.push(reference);
  }
  return missing;
}

export function withIssueLinks({ body, references }) {
  const links = references.map(({ label, url }) => `[${label}](${url})`).join(" ");
  const existing = typeof body === "string" ? body.replace(/^[\r\n]+/, "") : "";
  return existing ? `${links}\n\n${existing}` : links;
}

export function register(app) {
  app.on("pull_request.opened", async (context) => {
    const { issueLinks } = await loadAiReviewConfig(context);
    if (!issueLinks.automatic || issueLinks.rules.length === 0) return;

    const { owner, repo } = context.repo();
    if (!matchesFilterPatterns(issueLinks.repositories, repo)) return;

    const pr = context.payload.pull_request;
    const references = missingReferences({
      branch: pr.head?.ref,
      title: pr.title,
      body: pr.body,
      rules: issueLinks.rules,
    });
    if (references.length === 0) return;

    // The payload carries the description as it was at delivery. Re-read it
    // before overwriting, so an edit made in the meantime isn't clobbered.
    const { data: current } = await context.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pr.number,
    });
    const missing = references.filter((reference) => !mentionsReference(current.body, reference));
    if (missing.length === 0) return;

    await context.octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      body: withIssueLinks({ body: current.body, references: missing }),
    });
  });
}
