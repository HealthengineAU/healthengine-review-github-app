# Healthengine Review GitHub App

<div align=right>

⚙️ [Config](https://github.com/HealthengineAU/.github/blob/main/.github/healthengine-review.yml)
| 📲 [GitHub App](https://github.com/organizations/HealthengineAU/settings/apps/healthengine-review)

</div>

## Features

- Manages the `AI Review` commit status:
  - Added once a pull request has requested/received AI review
  - Tracks whether AI feedback has been addressed (i.e. resolved, responded to, is now outdated)
  - Can be skipped with `skip-ai-review` label
- Triggers AI reviews:
  - Commenting `ai review` (or `<provider> review` for a specific bot)
  - Requesting review from teams named `HealthengineAU/AI Review` or `HealthengineAU/<provider>`
  - Labelling a pull request with `ai-review` label
- Cleans up AI reviewer comments:
  - Removing links to unsupported features
  - Collapses summaries
- Admin merge:
  - An authorized user commenting `admin merge` squash-merges the pull request, bypassing checks
  - Authorized users are configured via `merge_admins` (see below)

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

# GitHub logins allowed to force a squash merge with `admin merge`.
# Resolved only from the default branch / org repo, never a PR branch.
merge_admins:
  - reece-como
```
