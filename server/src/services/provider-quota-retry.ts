export function buildProviderQuotaRetryIdempotencyKey(input: {
  companyId: string;
  issueId: string;
  retryNotBefore: Date;
}) {
  return [
    "provider-quota-retry",
    input.companyId,
    input.issueId,
    input.retryNotBefore.toISOString(),
  ].join(":");
}
