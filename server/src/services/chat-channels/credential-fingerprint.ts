import { createHash } from "node:crypto";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";

export function credentialFingerprint(refs: ToolCredentialSecretRef[]): string {
  const stable = refs.map(ref => ({ configPath: ref.configPath, secretId: ref.secretId,
    versionSelector: ref.versionSelector ?? "latest" })).sort((left, right) =>
    `${left.configPath}:${left.secretId}:${left.versionSelector}`.localeCompare(
      `${right.configPath}:${right.secretId}:${right.versionSelector}`));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
