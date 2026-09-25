# Healthengine Review GitHub App

<div align=right>

⚙️ [Config](https://github.com/HealthengineAU/.github/blob/main/.github/healthengine-review.yml)
| 📲 [GitHub App](https://github.com/organizations/HealthengineAU/settings/apps/healthengine-review)

</div>

## Features

- Manages the `AI Review` commit status:
  - Added once a pull request has requested/received AI review
  - Shows a passing `Requested <reviewer>` state as soon as a review is
    summoned (via any trigger below, a requested Copilot reviewer, or a
    human-typed `auggie review` comment), then flips to `Reviewed by …`
  - Tracks whether AI feedback has been addressed (i.e. resolved, responded to, is now outdated)
  - Can be skipped with the `ai_review.skip_label` label (no default — a label
    only waives the review when the config names one), or for specific PR
    authors via `ai_review.skip_authors` (default `dependabot[bot]`)
  - Passes automatically on PRs too small to be worth a review
    (under `ai_review.min_diff_size` changed lines, default 10)
  - Holds bot-authored PRs at pending until enough humans have approved
    (`ai_review.bot_pr_human_approvers`, default 2; `exclude` exempts specific bots)
- Triggers AI reviews:
  - Commenting `ai review` (or `<provider> review` for a specific bot)
  - Requesting review from teams named `HealthengineAU/AI Review` or `HealthengineAU/<provider>`
  - Labelling a pull request with `ai-review` label
  - Summoning Dusty posts `@<org>/dusty review` and wakes its agent proxy as
    the person who asked — nothing outside this app watches for that comment,
    and Dusty only takes a mention from an org member. Dusty is only summonable
    where an `agents` entry can reach it, whatever `providers` says
- Automatically invites a random AI reviewer (opt-in via `ai_review.automatic`):
  - When a pull request is opened, marked ready for review, or reopened
  - Only when the PR has no completed AI review and no pending AI review
    request (a requested Copilot, an Auggie or Dusty summon, an AI-review team request,
    or an incoming LinearB review — detected via a present, non-failing
    `gitStream.cm` commit status)
  - Evaluated ~30s after the PR event so gitStream's status has time to land
  - Skips authors listed in `ai_review.skip_authors` (default `dependabot[bot]`),
    PRs carrying the `ai_review.skip_label` label, and drafts (unless
    `ai_review.include_drafts: true`)
  - Configurable via `ai_review` (see below): target branches, repos, and
    authors as GitHub-Actions-style filter patterns, plus min/max diff size
    (defaults 0–2000 changed lines)
- Cleans up AI reviewer comments:
  - Removing links to unsupported features
  - Collapses summaries
- Links the issue a pull request is for into its description (opt-in via `issue_links`):
  - On `pull_request.opened`, when the branch name or title names an issue
    (`ABC-123`) and the description neither mentions nor links it
  - `issue_links.rules` says which keys count and where each points, so
    `cs-123` and `thing-session-220` can reach different trackers — a key no
    rule claims (`node-21`, `hono-4-13-8`) is never linked
  - Descriptions that already name the issue are left alone, so a tracker that
    auto-links keys itself isn't doubled up on
- Forwards activity to autonomous agent proxies (opt-in via `agents`):
  - Wakes an agent when its own PRs receive a review, a comment, or a failed/errored status check, and when it's `@`-mentioned on any PR
  - Coalesces bursts (debounced) and pokes the agent via a `workflow_dispatch`
    to a target it configures — the app itself knows nothing about any agent
  - Answers every comment that wakes an agent with 👀 on arrival, swapped for 👍
    once the wake is queued. A comment on an issue in the agent's own repo —
    which it watches itself — goes straight to 👍. It means "received", not "done"

- Starts incidents from Slack (`/incident`, see below):
  - One short form raises an `INCY` Incident, posts a triage thread in the
    current channel (default) or the incidents channel, reacts, pins it, and
    links the thread back onto the issue
  - Or it opens a code-named private channel: the Jira summary is the code name
    (`Wintery Snowfall Incident`) and the channel adds the key (`incy-1234-wintery-snowfall`).
    The issue is labelled `private`, the summary is posted only inside the
    channel, and updates go to the channel rather than a thread
  - *Mitigated* / *Resolved* buttons rename the issue with the prefix Jira
    automations key off, unpin the thread, and swap the reaction
  - A *Draft incident report* button tags Dusty in the thread, which is what
    turns the thread's transcript into the report. It invites Dusty to the
    channel first, if Dusty isn't already there

## Incident command

`/incident` is a **second Slack app**, not Dusty's. Its "Draft incident report"
button tags `@Dusty`, and Dusty's proxy drops mentions authored by its own app —
so this needs its own identity, and its `app_id` belongs in the sidecar's
`SLACK_ALLOWED_BOT_APPS` for those mentions to be honoured.

Slack's own Jira Cloud steps are not an option here for two reasons, both fatal:
they authenticate per runner (so everyone raising an incident would need their
own linked Atlassian account, mid-incident), and their *Edit issue* step cannot
write custom fields — which is every field that matters on `INCY`.

1. Create a Slack app from [`slack/incident-manifest.json`](slack/incident-manifest.json)
2. Copy the **Signing Secret** → `INCIDENT_SLACK_SIGNING_SECRET` and the
   **Bot User OAuth Token** (`xoxb-…`) → `INCIDENT_SLACK_BOT_TOKEN`
3. Add the new app's `app_id` to `SLACK_ALLOWED_BOT_APPS`
4. Set `INCIDENT_CHANNEL_ID` (the `C…` of the incidents channel), `INCIDENT_DUSTY_USER_ID`
   (Dusty's `U…`), and the `JIRA_*` values for a **licensed service account** with
   Create Issues, Edit Issues and — for real attribution — Modify Reporter on `INCY`

Notes:

- **Severity and Incident start are never asked for.** The Jira fields default to
  SEV-4 and to creation time, and a severity question up front is exactly the
  hesitation the command exists to remove. Severity is set later, in Jira.
- **This channel** is offered only where the app can post: a public channel, or
  a private one it has been added to. Private incident channels need
  `groups:write`; the lookup needs `channels:read` and `groups:read`. Inviting
  Dusty into a public channel needs `channels:manage`.
- **Reporter** is mapped from the Slack user's email to an Atlassian `accountId`.
  Jira hides emails under some privacy settings; when the lookup misses, the
  service account stays the reporter rather than the incident failing.
- **The Slack thread is a remote issue link**, not a field — `INCY` has none for
  it, and the `globalId` means a retry updates the link instead of adding another.
- **No state is stored.** Every button carries the issue key, channel and thread
  it acts on, so a restart loses nothing and a double-press is deduped.

## Tests

Unit and handler tests run on the built-in Node test runner (no extra dependencies):

```sh
npm test
```

They also run automatically on every pull request and on pushes to `main` via
the [Test workflow](.github/workflows/test.yml). Tests live in [test/](test/):
pure helpers are tested directly, and event handlers are exercised against a
lightweight `octokit`/`context` mock in [test/helpers/mock-github.js](test/helpers/mock-github.js).

## Config file

Use the [.github/healthengine-review.yml](https://github.com/HealthengineAU/.github/blob/main/.github/healthengine-review.yml) file in the organization's special `.github` repo to configure settings for all repos:

```yml
# supported: augment, claude, copilot, dusty, greptile, linearb
#
# `dusty` also needs an `agents` entry named `dusty` below — that's how the
# summon reaches it. Without one it is never summoned, listed here or not.
providers:
  - augment
  - claude
  - copilot
  - dusty
  - greptile
  - linearb

# AI review settings (all keys optional; defaults shown)
#
# branches / repositories / authors take GitHub-Actions-style filter patterns:
# `*` (segment wildcard), `**` (spans "/", for branch names), and `!` to
# negate a previous match — evaluated in order, last match wins. `[…]` matches
# a character range (`v[0-9]`) or the bracketed text literally, so bot logins
# like `dependabot[bot]` can be written as-is.
# Quote patterns that start with * or ! (YAML special characters).
ai_review:
  automatic: false       # set true to auto-invite a reviewer on eligible PRs
  include_drafts: false  # set true to also invite on draft PRs
  branches:              # base branches whose PRs are invited
    - master
    - main
    - develop
  repositories: ["*"]    # e.g. ["*", "!legacy-monolith"]
  authors: ["*"]         # e.g. ["*", "!*-service-account", "!dependabot[bot]"]
  skip_authors:          # PR authors whose PRs skip AI review entirely
    - "dependabot[bot]"  # (exact logins, case-insensitive; [] to skip no one)
  # skip_label: skip-ai-review  # a PR carrying this label waives the review
                                # (no default: unset means no label waives it)
  min_diff_size: 10      # inclusive bounds on additions + deletions;
  max_diff_size: 2000    # PRs outside the range aren't auto-invited.
                         # PRs under min_diff_size also pass the "AI Review"
                         # status without a review (0 disables both)
  provider_groups:          # optional: restrict which providers an invite picks
    - min_lines_added: 80   # lowest additions (default 0) this band accepts
      max_lines_added: 2000 # highest additions (default unbounded) it accepts
      providers:            # from. First matching band wins; a band picks at
        - augment           # random from its (enabled) providers and must
    - providers:            # satisfy every bound it declares. min_diff_size /
        - copilot           # max_diff_size band the same way on additions +
                            # deletions. Bands only narrow the `providers` list
                            # above — if a band's providers are all disabled, or
                            # no band covers the PR, the full enabled pool is
                            # used, so keep the last band unbounded.
  bot_pr_human_approvers:  # human approvals required on bot-authored PRs
    min: 2                 # minimum number of human approvers
    exclude:               # bot authors exempt from the requirement
      - "dependabot[bot]"  # (exact logins, case-insensitive; [] for none)

# Issue links (optional; omit the key entirely to disable).
#
# When a pull request is opened and its branch name or title names an issue the
# description doesn't mention, the key is prepended to the description as a
# link. Each rule claims a set of keys and says where they point; the first rule
# whose `keys` match wins. `keys` and `repositories` take the same filter
# patterns as ai_review above. Templates substitute $KEY (upper-cased), $key
# (lower-cased) and $NUMBER.
#
# Requires the app to have Pull requests: Read and write.
issue_links:
  automatic: false      # set true to start editing descriptions
  repositories: ["*"]   # e.g. ["*", "!legacy-monolith"]
  rules:
    - keys: [ABC, XY]   # abc-123, claude/XY-45-something, someone/abc-123-wip
      url: https://example.atlassian.net/browse/$KEY-$NUMBER
    - keys: [THING-SESSION]                # keys may span hyphens, and the
      label: "session #$NUMBER"            # longest one a rule claims wins —
                                           # thing-session-220 is not the same
                                           # key as other-session-220.
                                           # (quote values containing "#")
      url: https://github.com/example-org/example-repo/issues/$NUMBER

# Agent proxies (optional; omit the key entirely to disable).
#
# Each entry forwards pull-request activity to an autonomous agent that runs
# elsewhere and opens PRs under its own bot identity. The app stays generic —
# every identity, trigger, and dispatch target lives here in config.
#
# Requires the app to have Actions: Read and write on the dispatch target repo.
# `dispatch.owner` must be within the same org the events come from.
agents:
  - name: my-agent            # label, for logs
    bot: my-agent[bot]        # the agent's own login — matches its PRs, skips its own noise
    events: [review, comment, check, mention]   # which activity to forward (default: all four)
    mention: '@my-agent\b'    # regex; needed for `mention` events
    checks: '^buildkite/'     # regex over commit-status contexts; needed for `check` events
    ignore_users:             # human-looking service accounts to drop on comments
      - "healthengine-sre"
    debounce_seconds: 45      # coalesce a burst on one PR into one dispatch (max 300)
    dispatch:                 # where the agent gets poked (a workflow_dispatch)
      owner: HealthengineAU
      repo: my-agent
      workflow: webhook_event.yml  # optional, defaults to webhook_event.yml
      ref: main                    # optional, defaults to main
```

For each configured agent the app forwards:

- **review** / **comment** — a review or human comment on one of the agent's own
  PRs. Reviews accept humans *and* bots (AI reviewers count); comments are
  humans-only, minus `ignore_users`. Approvals are ignored.
- **mention** — a human `@`-mentioning the agent on any PR in the org.
- **check** — a settled (non-pending) commit status matching `checks` on one of
  the agent's PRs. The body carries the outcome, e.g. `failure: buildkite/test`.

Each dispatch sends `{ event, repo, pr, actor, body }` as workflow inputs. What
the agent does with them — and any authorization of `actor` — is the agent's own
concern.
