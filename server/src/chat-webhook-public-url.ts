/** Deployment-only ingress origin; never a board URL or a request-header hint. */
export function parseChatWebhookPublicBaseUrl(
  value: string | null | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {
    // Never include an operator-supplied URL: it could contain credentials.
  }
  throw new Error(
    "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL must be an HTTPS origin without credentials, a path, query, or fragment",
  );
}
