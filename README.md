# github-bot-ai-reviewed-prs

## What it does

- Adds a commit status once a pull request has requested AI reviews
  - Can be skipped with "skip-ai-review" label
- Manages bot review comments (removing dead links)
- Summons AI reviewers from PR comments, labels, or team review requests,
  gated by the providers enabled in `.github-bot-ai-reviewed-prs.yml`

## Configuration

Create `.github/.github-bot-ai-reviewed-prs.yml` to control which AI review providers are
enabled. Supported providers: `augment`, `claude`, `copilot`, `greptile`,
`linearb`.

```yml
providers:
  - augment
  - claude
  - copilot
  - greptile
  - linearb
```

Resolution order (handled by Probot):

1. `.github/.github-bot-ai-reviewed-prs.yml` in the PR's repo (read from the default branch only)
2. otherwise `.github/.github-bot-ai-reviewed-prs.yml` in the organization's `.github` repository
3. otherwise all providers are enabled (default)

Config files may also use `_extends: <repo>` to inherit from another repo.

Summoning a provider that isn't enabled (e.g. commenting "copilot please" when
`copilot` isn't listed) posts a notice instead of triggering a review. The
random reviewer only picks from enabled providers.

## Local setup

1. Create a GitHub App in GitHub, and install it on repositories.
2. Make an `.env` and set up your app credentials.

```sh
cp .env.example .env
npm install
npm run start
```

## Deployment

- Configured as a GitHub App
- Deploys as free-tier [Render (Web Service)](https://dashboard.render.com/) following [the GitHub Probot docs](https://probot.github.io/docs/deployment/#render)
- If Render GitHub App is installed, will auto-deploy from `main`
