export interface RunnerE2EHistoryPublicDestination {
  prefix: string;
  publicBaseUrl: string;
}

export function validateHistoryPublicDestination(input: {
  prefix: string;
  publicBaseUrl: string;
}): RunnerE2EHistoryPublicDestination {
  const prefix = input.prefix.replace(/^\/+|\/+$/g, "");
  const segments = prefix.split("/");
  if (
    !prefix ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~-]+$/.test(segment),
    )
  ) {
    throw new Error(
      "RUNNER_E2E_HISTORY_PREFIX must be a safe non-empty key prefix",
    );
  }
  const publicUrl = new URL(input.publicBaseUrl);
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      "RUNNER_E2E_HISTORY_PUBLIC_BASE_URL must be a credential-free HTTPS URL",
    );
  }
  return {
    prefix,
    publicBaseUrl: publicUrl.href.replace(/\/+$/, ""),
  };
}

export function validateHistoryDestination(input: {
  bucket: string;
  prefix: string;
  publicBaseUrl: string;
}) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) {
    throw new Error("RUNNER_E2E_HISTORY_S3_BUCKET is not a valid bucket name");
  }
  return validateHistoryPublicDestination(input);
}

export function runnerE2ECampaignPublicUrl(
  destination: RunnerE2EHistoryPublicDestination,
  campaignId: string,
) {
  return `${destination.publicBaseUrl}/${destination.prefix}/campaigns/${encodeURIComponent(campaignId)}/index.html`;
}
