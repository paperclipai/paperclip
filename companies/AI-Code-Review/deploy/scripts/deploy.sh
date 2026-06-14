#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-staging}"
NAMESPACE="codereview-${ENVIRONMENT}"
CLUSTER="codereview-${ENVIRONMENT}"
REGION="${AWS_REGION:-us-east-1}"

echo "=== Deploying to ${ENVIRONMENT} ==="

aws eks update-kubeconfig --name "${CLUSTER}" --region "${REGION}"

helm upgrade --install "codereview" ./deploy/charts/codereview \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --set environment="${ENVIRONMENT}" \
  --set image.tag="${IMAGE_TAG:-latest}" \
  --set ingress.host="${ENVIRONMENT}.codereview.ai" \
  --values "deploy/charts/codereview/values-${ENVIRONMENT}.yaml" \
  --wait --timeout 15m

echo "=== Health check ==="
ENDPOINT="https://${ENVIRONMENT}.codereview.ai/health"
for i in $(seq 1 12); do
  if curl -sf --max-time 10 "${ENDPOINT}" > /dev/null 2>&1; then
    echo "Health check passed"
    exit 0
  fi
  echo "Waiting... ($i/12)"
  sleep 5
done

echo "Health check failed after 60s"
exit 1
