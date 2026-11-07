import { createHash } from "node:crypto";
import { z } from "zod";
import {
  getCloudRuntimeIdentity,
  verifyCloudControlAssertion,
} from "../../services/cloud-runtime-identity.js";
import { paperclipCloudConnectorConfigFromEnv } from "../../services/paperclip-cloud-connector.js";

export const dotPrincipalControlPath = "/mcp/runner/oauth/cloud-principal";
export const dotPrincipalControlBodySchema = z
  .object({
    accessToken: z.string().min(1).max(256),
    upstreamClientId: z.string().min(1).max(2048),
    selectingUserId: z.string().min(1).max(200),
    canonicalVerifiedResource: z.string().url().max(2048),
    expectedInstanceId: z.string().min(1).max(200),
    requestedCompanyId: z.uuid().optional(),
  })
  .strict();
export type DotPrincipalControlBody = z.infer<
  typeof dotPrincipalControlBodySchema
>;
export function dotPrincipalControlDigest(body: DotPrincipalControlBody) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "paperclip-dot-original-principal-v1",
        "mcp-dot:principal",
        body.expectedInstanceId,
        body.canonicalVerifiedResource,
        body.upstreamClientId,
        body.selectingUserId,
        body.requestedCompanyId ?? null,
        body.accessToken,
      ]),
    )
    .digest("hex");
}
export function verifyDotPrincipalControl(
  compactJws: string,
  body: DotPrincipalControlBody,
  now: Date,
) {
  if (compactJws.length > 8192)
    throw new Error("Invalid Dot principal assertion");
  const parts = compactJws.split(".");
  if (parts.length !== 3) throw new Error("Invalid Dot principal assertion");
  const untrusted: unknown = JSON.parse(
    Buffer.from(parts[1]!, "base64url").toString("utf8"),
  );
  if (
    !untrusted ||
    typeof untrusted !== "object" ||
    Array.isArray(untrusted) ||
    !("requestId" in untrusted) ||
    typeof untrusted.requestId !== "string" ||
    !/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.[a-f0-9]{64}$/.test(
      untrusted.requestId,
    ) ||
    untrusted.requestId.slice(37) !== dotPrincipalControlDigest(body) ||
    !("iat" in untrusted) || !("exp" in untrusted) ||
    typeof untrusted.iat !== "number" || typeof untrusted.exp !== "number" ||
    !Number.isSafeInteger(untrusted.iat) ||
    !Number.isSafeInteger(untrusted.exp) ||
    Number(untrusted.exp) <= Number(untrusted.iat) ||
    Number(untrusted.exp) - Number(untrusted.iat) > 60
  )
    throw new Error("Invalid Dot principal assertion binding");
  return verifyCloudControlAssertion({
    compactJws,
    expectedAction: "mcp-dot:principal",
    now,
  });
}
export function readDotPrincipalControlAuthority() {
  const identity = getCloudRuntimeIdentity(),
    connector = paperclipCloudConnectorConfigFromEnv();
  return identity && connector
    ? {
        stackId: identity.stackId,
        claimId: identity.claimId,
        canonicalOrigin: identity.canonicalOrigin,
        instanceId: connector.instanceId,
        environment: connector.environment,
        baseUrl: connector.baseUrl,
        signPrivateKey: connector.signPrivateKey,
        sealPrivateKey: connector.sealPrivateKey,
      }
    : null;
}
export type DotPrincipalControlAuthority = NonNullable<
  ReturnType<typeof readDotPrincipalControlAuthority>
>;
export function sameDotPrincipalControlAuthority(
  left: DotPrincipalControlAuthority,
  right: DotPrincipalControlAuthority | null,
) {
  return (
    right !== null &&
    left.stackId === right.stackId &&
    left.claimId === right.claimId &&
    left.canonicalOrigin === right.canonicalOrigin &&
    left.instanceId === right.instanceId &&
    left.environment === right.environment &&
    left.baseUrl === right.baseUrl &&
    left.signPrivateKey === right.signPrivateKey &&
    left.sealPrivateKey === right.sealPrivateKey
  );
}
