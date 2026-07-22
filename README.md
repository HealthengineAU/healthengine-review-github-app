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
  - Can be skipped with `skip-ai-review` label, or for specific PR authors via
    `ai_review.skip_authors` (default `dependabot[bot]`)
- Triggers AI reviews:
  - Commenting `ai review` (or `<provider> review` for a specific bot)
  - Requesting review from teams named `HealthengineAU/AI Review` or `HealthengineAU/<provider>`
  - Labelling a pull request with `ai-review` label
- Automatically invites a random AI reviewer (opt-in via `ai_review.automatic`):
  - When a pull request is opened, marked ready for review, or reopened
  - Only when the PR has no completed AI review and no pending AI review
    request (a requested Copilot, an Auggie summon, an AI-review team request,
    or an incoming LinearB review — detected via a present, non-failing
    `gitStream.cm` commit status)
  - Evaluated ~30s after the PR event so gitStream's status has time to land
  - Skips authors listed in `ai_review.skip_authors` (default `dependabot[bot]`),
    PRs labelled `skip-ai-review`, and drafts (unless `ai_review.include_drafts: true`)
  - Configurable via `ai_review` (see below): target branches, repos, and
    authors as GitHub-Actions-style filter patterns, plus min/max diff size
    (defaults 0–2000 changed lines)
- Cleans up AI reviewer comments:
  - Removing links to unsupported features
  - Collapses summaries

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
# supported: augment, claude, copilot, greptile, linearb
providers:
  - augment
  - claude
  - copilot
  - greptile
  - linearb

# AI review settings (all keys optional; defaults shown)
#
# branches / repositories / authors take GitHub-Actions-style filter patterns:
# `*` (segment wildcard), `**` (spans "/", for branch names), and `!` to
# negate a previous match — evaluated in order, last match wins.
# Quote patterns that start with * or ! (YAML special characters).
ai_review:
  automatic: false       # set true to auto-invite a reviewer on eligible PRs
  include_drafts: false  # set true to also invite on draft PRs
  branches:              # base branches whose PRs are invited
    - master
    - main
    - develop
  repositories: ["*"]    # e.g. ["*", "!legacy-monolith"]
  authors: ["*"]         # e.g. ["*", "!*-service-account"]
  min_diff_size: 0       # inclusive bounds on additions + deletions;
  max_diff_size: 2000    # PRs outside the range aren't auto-invited
```
