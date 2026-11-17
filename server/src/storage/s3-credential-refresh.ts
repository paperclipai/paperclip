import type { S3Client } from "@aws-sdk/client-s3";
import { isCredentialRejectionCode } from "./storage-unavailable.js";

type CredentialProvider = (options?: { forceRefresh?: boolean }) => Promise<unknown>;

function rejectsCredentials(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, Code, $metadata } = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status = typeof $metadata?.httpStatusCode === "number" ? $metadata.httpStatusCode : null;
  return isCredentialRejectionCode(name, status) || isCredentialRejectionCode(Code, status);
}

export function refreshS3CredentialsOnRejection(client: S3Client): void {
  let refreshing: Promise<unknown> | null = null;
  const provider = () => {
    const credentials = client.config.credentials as unknown as CredentialProvider | undefined;
    return typeof credentials === "function" ? credentials : null;
  };
  const current = () => provider()?.().catch(() => undefined) ?? Promise.resolve(undefined);
  const refresh = async (used: unknown) => {
    const credentials = provider();
    if (!credentials) return;
    if (!refreshing) {
      if (used !== undefined && await current() !== used) return;
      refreshing ??= credentials({ forceRefresh: true }).catch(() => undefined).finally(() => { refreshing = null; });
    }
    await refreshing;
  };
  client.middlewareStack.add(
    (next) => async (args) => {
      const used = await current();
      try {
        return await next(args);
      } catch (error) {
        if (rejectsCredentials(error)) await refresh(used);
        throw error;
      }
    },
    { step: "initialize", priority: "low", name: "paperclipS3CredentialRefresh" },
  );
}
