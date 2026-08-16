type ProviderQuotaRetryIdempotencyKeyInput = {
  companyId: string;
  issueId: string;
} & (
  | { retryNotBefore: Date; fallbackBoundary?: never }
  | { retryNotBefore?: null; fallbackBoundary: string }
);

export function buildProviderQuotaRetryIdempotencyKey(input: ProviderQuotaRetryIdempotencyKeyInput) {
  const boundary = input.retryNotBefore
    ? input.retryNotBefore.toISOString()
    : `fallback:${input.fallbackBoundary}`;
  return [
    "provider-quota-retry",
    input.companyId,
    input.issueId,
    boundary,
  ].join(":");
}
