#!/bin/bash

set -o errexit
set -o nounset
set -o pipefail

# Clean up from any previous runs.
echo "--- :wastebasket: Removing old test pods"
kubectl delete pod github-bot-ai-reviewed-prs-test --namespace github-bot-ai-reviewed-prs || true

echo "--- :arrows_counterclockwise: Syncing new version"
deploy-helm.sh "$BUILDKITE_AGENT_META_DATA_CLUSTER" github-bot-ai-reviewed-prs

echo "--- :stethoscope: Running smoke test"
if ! deploy-helm.sh --test "$BUILDKITE_AGENT_META_DATA_CLUSTER" github-bot-ai-reviewed-prs
then
  echo "--- :no_entry: Test failed, rolling back"

  deploy-helm.sh --namespace github-bot-ai-reviewed-prs --rollback "$BUILDKITE_AGENT_META_DATA_CLUSTER" github-bot-ai-reviewed-prs

  echo "+++ Test logs"
  kubectl logs github-bot-ai-reviewed-prs-test --namespace github-bot-ai-reviewed-prs || true

  exit 1
else
  echo "--- :partyparrot: Deployed"
fi
