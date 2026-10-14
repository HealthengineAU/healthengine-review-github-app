// Injects a link to the issue a pull request is for into its description, when
// the branch name or title names one and the description doesn't — on open,
// and again whenever an edit drops it.
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

import { DEFAULT_SEPARATOR, loadAiReviewConfig } from "./config.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

// A KEY-123 token: the key starts on a boundary (a hyphen counts, so keys
// stack: "noot-334-mkt-123") and runs to the first "-<digits>", so it can span
// hyphens ("some-thing-220"). A version-style ".4" after the number rules it
// out, so "core-app-1.2.328" and "joi-17.13.8" aren't issues; a trailing
// letter is a sub-branch marker ("ABC-284a") and isn't part of the reference.
const REFERENCE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9-]*?)-(\d+)(?!\.?\d)/g;

// The keys a matched run could be, most specific first, so a rule for
// "some-thing" wins over one for "thing" where both are configured.
function keyCandidates(run) {
  const segments = run.split("-");
  return segments
    .map((_, index) => segments.slice(index).join("-"))
    .filter((candidate) => /^[A-Za-z]/.test(candidate));
}

// $KEY / $key / $NUMBER in a rule's `link` template.
function fillTemplate(template, key, number) {
  return template
    .replaceAll("$KEY", key.toUpperCase())
    .replaceAll("$key", key.toLowerCase())
    .replaceAll("$NUMBER", number);
}

function linkUrl(link) {
  return /\]\(((?:[^\s()]|\([^\s()]*\))+)\)/.exec(link)?.[1] ?? null;
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
      link: fillTemplate(rule.link, key, number),
    };
    if (!references.some((seen) => seen.link === reference.link)) {
      references.push(reference);
    }
  }
  return references;
}

// Does the description already point at this issue — as a key the tracker will
// auto-link, or as the link itself? Either way we leave it alone.
export function mentionsReference(body, { token, link }) {
  if (typeof body !== "string") return false;
  if (body.includes(linkUrl(link) ?? link)) return true;
  return new RegExp(`(?<![A-Za-z0-9])${token}(?![A-Za-z0-9])`, "i").test(body);
}

// Every reference the branch or title names, branch first, deduped.
export function namedReferences({ branch, title, rules }) {
  const named = [];
  for (const reference of [...extractReferences(branch, rules), ...extractReferences(title, rules)]) {
    if (!named.some((seen) => seen.link === reference.link)) named.push(reference);
  }
  return named;
}

// The references named by the branch or title that the description is missing.
export function missingReferences({ branch, title, body, rules }) {
  return namedReferences({ branch, title, rules }).filter((reference) => !mentionsReference(body, reference));
}

// The line the app owns is tagged with an invisible marker, so a later pass
// replaces it in place rather than stacking another above it. The marker trails
// the links: a line opening with "<!--" is an HTML block and wouldn't render.
export const ISSUE_LINKS_MARKER = "<!-- issue-links -->";
const MARKED_LINE = /^.*<!-- issue-links -->.*$/m;

export function withIssueLinks({ body, references, separator = DEFAULT_SEPARATOR }) {
  const line = `${references.map(({ link }) => link).join(` ${separator} `)} ${ISSUE_LINKS_MARKER}`;
  const existing = typeof body === "string" ? body : "";
  if (MARKED_LINE.test(existing)) return existing.replace(MARKED_LINE, () => line);
  const rest = existing.replace(/^[\r\n]+/, "");
  return rest ? `${line}\n\n${rest}` : line;
}

// The description with its issue-links line brought up to date, or null when
// there's nothing to change: no marked line and every reference already
// mentioned, or a marked line that already reads as it should.
export function updatedDescription({ branch, title, body, rules, separator }) {
  const references = namedReferences({ branch, title, rules });
  if (references.length === 0) return null;
  const text = typeof body === "string" ? body : "";
  if (!MARKED_LINE.test(text) && missingReferences({ branch, title, body, rules }).length === 0) return null;
  const next = withIssueLinks({ body: text, references, separator });
  return next === text ? null : next;
}

export function register(app) {
  app.on(["pull_request.opened", "pull_request.edited"], async (context) => {
    const { issueLinks } = await loadAiReviewConfig(context);
    if (!issueLinks.automatic || issueLinks.rules.length === 0) return;

    const { owner, repo } = context.repo();
    if (!matchesFilterPatterns(issueLinks.repositories, repo)) return;

    const pr = context.payload.pull_request;
    const naming = { branch: pr.head?.ref, title: pr.title, rules: issueLinks.rules, separator: issueLinks.separator };
    if (updatedDescription({ ...naming, body: pr.body }) === null) return;

    // The payload carries the description as it was at delivery. Re-read it
    // before overwriting, so an edit made in the meantime isn't clobbered.
    const { data: current } = await context.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pr.number,
    });
    const body = updatedDescription({ ...naming, body: current.body });
    if (body === null) return;

    await context.octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, body });
  });
}
