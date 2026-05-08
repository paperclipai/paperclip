const SLACK_WEBHOOK_ALLOWED_HOSTS = new Set([
  "hooks.slack.com",
  "hooks.slack-gov.com",
]);

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

export const ALLOW_INSECURE_WEBHOOK_URLS_ENV = "ALLOW_INSECURE_WEBHOOK_URLS";

export type ValidateSlackWebhookUrlOptions = {
  allowInsecureWebhookUrls: boolean;
  isProductionLike: boolean;
};

export type ValidatedSlackWebhookUrl = {
  normalizedUrl: string;
  usedInsecureException: boolean;
  hostname: string;
};

export function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isProductionLikeRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const deploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE?.trim().toLowerCase();
  return nodeEnv === "production" || deploymentMode === "authenticated";
}

export function isSlackWebhookSecretName(name: string): boolean {
  const canonical = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return canonical === "SLACK_WEBHOOK_URL" || canonical.endsWith("_SLACK_WEBHOOK_URL");
}

export function validateSlackWebhookUrl(
  rawValue: string,
  options: ValidateSlackWebhookUrlOptions,
): ValidatedSlackWebhookUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error("Slack webhook URL is invalid. Provide a valid absolute URL.");
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();

  if (parsed.username || parsed.password) {
    throw new Error("Slack webhook URL cannot include embedded credentials.");
  }

  if (protocol === "https:") {
    if (!SLACK_WEBHOOK_ALLOWED_HOSTS.has(hostname)) {
      throw new Error("Slack webhook URL host is not allowed. Use hooks.slack.com or hooks.slack-gov.com.");
    }
    return {
      normalizedUrl: parsed.toString(),
      usedInsecureException: false,
      hostname,
    };
  }

  if (protocol !== "http:") {
    throw new Error("Slack webhook URL must use https:// (or http:// loopback in approved local exception mode).");
  }

  const insecureModeAllowed =
    options.allowInsecureWebhookUrls &&
    !options.isProductionLike &&
    LOOPBACK_HOSTS.has(hostname);

  if (!insecureModeAllowed) {
    throw new Error(
      "Slack webhook URL must use https://. Local http:// is allowed only for loopback hosts in non-production when ALLOW_INSECURE_WEBHOOK_URLS=true.",
    );
  }

  return {
    normalizedUrl: parsed.toString(),
    usedInsecureException: true,
    hostname,
  };
}
