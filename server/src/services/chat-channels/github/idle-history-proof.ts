export function completedGithubAction(a: string): string {
  return `(${a}.kind = 'github_response_comment' AND ${a}.status = 'processed' AND ${a}.result->>'final' = 'true')
    OR (${a}.kind = 'github_webhook_ingress' AND (
      (${a}.status = 'processed' AND ${a}.result->>'httpStatus' = '202' AND ${a}.result->>'retryable' = 'false')
      OR (${a}.status = 'failed' AND ${a}.result->>'code' = 'github_webhook_ingress_payload_invalid'
        AND ${a}.result->>'retryable' = 'false')))
    OR (${a}.kind = 'github_review_check' AND ${a}.status = 'processed'
      AND ${a}.result->>'retryable' = 'false')`;
}
