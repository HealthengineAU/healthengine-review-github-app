# GitHub Probot App

## What it does

- Adds a commit status once a pull request has requested AI reviews
  - Can be skipped with "skip-ai-review" label
- Manages bot review comments (removing dead links)

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
