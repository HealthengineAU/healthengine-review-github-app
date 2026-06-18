#!/bin/bash

set -o errexit
set -o nounset
set -o pipefail

# Clean up from any previous runs.
echo "--- :wastebasket: Removing old test pods"
kubectl delete pod healthengine-review-github-app-test --namespace healthengine-review-github-app || true

echo "--- :arrows_counterclockwise: Syncing new version"
deploy-helm.sh "$BUILDKITE_AGENT_META_DATA_CLUSTER" healthengine-review-github-app

echo "--- :stethoscope: Running smoke test"
if ! deploy-helm.sh --test "$BUILDKITE_AGENT_META_DATA_CLUSTER" healthengine-review-github-app
then
  echo "--- :no_entry: Test failed, rolling back"

  deploy-helm.sh --namespace healthengine-review-github-app --rollback "$BUILDKITE_AGENT_META_DATA_CLUSTER" healthengine-review-github-app

  echo "+++ Test logs"
  kubectl logs healthengine-review-github-app-test --namespace healthengine-review-github-app || true

  exit 1
else
  echo "--- :partyparrot: Deployed"
fi
