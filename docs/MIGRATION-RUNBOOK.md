# Migration runbook — Render → HealthEngine Kubernetes

This service used to run on Render (free tier, personal account). It now deploys to the prod
Kubernetes clusters via the standard HE app-owned pattern (modelled on `catalyst` / `docker-ssosync`):

```
push to main → Buildkite build (build image, push to ECR)
            → bk_trigger_deploy.py triggers <pipeline>-deploy with DOCKER_BUILD_TAG
            → deploy-helm.sh runs `helmfile sync` (chamber injects secrets from SSM)
            → rolling update on the prod clusters
```

- **Prod only** (no test-cluster stage).
- **Webhook host:** `https://github-bot-ai-reviewed-prs.<PUBLIC_DOMAIN>/api/github/webhooks` (Traefik + Let's Encrypt).
- **Health check:** `GET /ping` → `PONG`.
- **Secrets:** `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` (no DB).

## Files added (across three repos)

| Repo | Files |
|------|-------|
| this repo | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.buildkite/pipeline.yml`, `.buildkite/pipeline.deploy.yml`, `.buildkite/pipeline.scan.yml`, `helm/chart/github-bot-ai-reviewed-prs/**`, `helm/vars/values.yaml.gotmpl`, `helmfile.yaml.gotmpl`, `tools/deploy-and-test.sh`, `.github/CODEOWNERS` |
| `iac` | `github-bot-ai-reviewed-prs.tf` |
| `k8s` | `cf/config/shared-services/ecr/github-bot-ai-reviewed-prs.yaml`, `cf/config/heaws/iam-role/pipeline-github-bot-ai-reviewed-prs.yaml`, `…-main.yaml`; edits to `helm/vars/namespaces.yaml.gotmpl`, `helm/vars/rbac-pipelines.yaml.gotmpl`, `helm/vars/iam-identity-mappings.yaml.gotmpl`, `tools/configure-cluster.sh` |

## Prerequisites

- AWS access to the `heaws` (prod, 340978087534) and `shared-services` (759931498410) accounts.
- Ability to merge to `iac` and `k8s` (platform-team review) and to run their Buildkite/Sceptre apply flows.
- Admin on the `github-bot-ai-reviewed-prs` GitHub App (org → Settings → Developer settings → GitHub Apps).
- The current Render env values (Render dashboard → service → Environment): `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`.

## Cutover (ordered)

Ordering matters: ECR + pipeline IAM roles (k8s `cf`) and the Buildkite pipelines (`iac`) must exist before
the first `main` build; the namespace/RBAC/identity mappings (k8s helmfile) and the secrets must exist before
the first deploy.

### 1. k8s — CloudFormation (ECR + pipeline IAM roles)
Apply via the k8s repo's normal Sceptre flow:
- `cf/config/shared-services/ecr/github-bot-ai-reviewed-prs.yaml` → creates ECR repos
  `github-bot-ai-reviewed-prs` and `github-bot-ai-reviewed-prs-prod` (template default `CreateSeparateProdEcr: true`).
- `cf/config/heaws/iam-role/pipeline-github-bot-ai-reviewed-prs.yaml` and `…-main.yaml` → the pipeline IAM
  roles; `…-main` grants `ssm:GetParameter*` on `/helm/prod*/github-bot-ai-reviewed-prs/*`.

### 2. k8s — central config (namespace, RBAC, identity mappings)
The edits to `helm/vars/{namespaces,rbac-pipelines,iam-identity-mappings}.yaml.gotmpl` take effect when the
`namespaces`, `rbac`, and aws-auth/identity-mapping releases are synced to each prod cluster (the same
mechanism `tools/configure-cluster.sh` uses). Sync them to the prod app clusters before deploying the bot.

### 3. iac — Buildkite pipelines + repo webhook (Terraform, with import)
The repo already exists on GitHub, so import it before applying (otherwise Terraform tries to create it):
```sh
terraform import 'module.github_github-bot-ai-reviewed-prs.github_repository.this' github-bot-ai-reviewed-prs
terraform plan    # MUST show no destroy of the repo; import any pre-existing
                  # github_branch_default.this / github_repository_ruleset.this it reports
terraform fmt     # CI checks `terraform fmt -check` — run it, I could not locally
```
Then apply via the normal iac flow. This creates the `github-bot-ai-reviewed-prs`,
`…-deploy`, and `…-scan` Buildkite pipelines and the push webhook on the repo, plus the
shared-services `build-*` IAM roles that push to ECR. NOTE: the github-repository module also applies the
standard branch-protection ruleset (2 approvals, code-owner review, required check
`buildkite/github-bot-ai-reviewed-prs`).

### 4. Secrets → SSM
`PRIVATE_KEY` is base64-encoded (Probot's `@probot/get-private-key` decodes base64 automatically; this avoids
newline issues through SSM/chamber):
```sh
# Save the Render PRIVATE_KEY PEM to private-key.pem first.
PRIVATE_KEY_B64=$(base64 -i private-key.pem | tr -d '\n')   # macOS
APP_ID=...           # from Render
WEBHOOK_SECRET=...   # from Render

# ssm_put.sh ENVIRONMENT PARAM VALUE  -> stores /helm/<ENV>/<param, lowercased>, chamber re-exposes UPPERCASE.
# Do this for each prod app cluster the deploy targets (namespaces exist on all prod clusters except prod1,
# i.e. prod2/prod3 — confirm against the prod deploy/cluster config).
for CLUSTER in prod2 prod3; do
  k8s/tools/ssm_put.sh --secure --hide-value "$CLUSTER" github-bot-ai-reviewed-prs/APP_ID         "$APP_ID"
  k8s/tools/ssm_put.sh --secure --hide-value "$CLUSTER" github-bot-ai-reviewed-prs/PRIVATE_KEY    "$PRIVATE_KEY_B64"
  k8s/tools/ssm_put.sh --secure --hide-value "$CLUSTER" github-bot-ai-reviewed-prs/WEBHOOK_SECRET "$WEBHOOK_SECRET"
done
rm -f private-key.pem
```

### 5. Ship the app
Merge this repo's changes to `main`. The build pipeline builds + pushes the image and (on `main`) triggers the
prod deploy, which runs `helmfile sync`. Watch the build in Buildkite.

### 6. Repoint the GitHub App webhook
GitHub org → Settings → Developer settings → GitHub Apps → **github-bot-ai-reviewed-prs** → set
**Webhook URL** to `https://github-bot-ai-reviewed-prs.<PUBLIC_DOMAIN>/api/github/webhooks`
(use the real PUBLIC_DOMAIN). Then **Advanced → Recent Deliveries → Redeliver** a ping and confirm a 2xx;
watch `kubectl -n github-bot-ai-reviewed-prs logs deploy/github-bot-ai-reviewed-prs`.

### 7. Decommission Render
Delete the Render service in the personal account, then remove `render.yaml` from this repo.

## Verification

```sh
kubectl -n github-bot-ai-reviewed-prs get pods,svc,ingress
kubectl -n github-bot-ai-reviewed-prs logs deploy/github-bot-ai-reviewed-prs   # "Listening on http://0.0.0.0:3000"
curl -fsS https://github-bot-ai-reviewed-prs.<PUBLIC_DOMAIN>/ping              # -> PONG, valid TLS
```
The deploy also runs a Helm smoke test (`tools/deploy-and-test.sh` → `deploy-helm.sh --test`) that curls
`/ping` and auto-rolls-back on failure. End-to-end: redeliver a webhook (step 6) and/or open a test PR and
confirm the bot reacts.

## Rollback
- Buildkite `github-bot-ai-reviewed-prs-deploy` has a manual **Rollback** block step (`helm rollback`).
- Fastest emergency fallback: point the GitHub App webhook URL back at the Render service (keep it until the
  new deploy is verified before doing step 7).

## Things to verify during cutover (see also the plan)
- **WAF:** if the external ALB's WAF default-denies, add an allow rule for the host
  (`k8s/cf/config/heaws/waf/acl.yaml`) so GitHub's webhook IPs reach the app.
- **DNS:** confirm `github-bot-ai-reviewed-prs.<PUBLIC_DOMAIN>` resolves to the internet-facing ALB (existing
  wildcard, or add a Route53 record). If a default wildcard TLS cert already covers the host, the
  `cert-manager.io/cluster-issuer` annotation + `tls` block in `helm/vars/values.yaml.gotmpl` can be dropped.
- **Prod cluster set:** confirm which prod clusters the deploy targets and that secrets exist in each.
