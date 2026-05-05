# GitHub Probot App

## What it does

- Adds a commit status once a pull request has AI reviews

## Local setup

1. Create a GitHub App in GitHub, and install it on repositories.
2. Make an `.env` and set up your app credentials.

```sh
cp .env.example .env

npm install

npm run dev
```

## Deployment

- Configured as a GitHub App
- Deploys as free-tier [Render (Web Service)](https://dashboard.render.com/) following [the GitHub Probot docs](https://probot.github.io/docs/deployment/#render)
- Auto-deploy on commits to `main`
