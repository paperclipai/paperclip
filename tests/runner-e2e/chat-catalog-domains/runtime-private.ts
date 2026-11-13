import { createHash } from "node:crypto";
import { runtimePrivateRequirements } from "../chat-runtime-private-requirements.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
export type RuntimePrivateCaseId = keyof typeof runtimePrivateRequirements;
export function runtimePrivateSpec(id: RuntimePrivateCaseId) {
  const spec = runtimePrivateRequirements[id];
  return { requiredCredentials: spec.credentials, externalInput: { provider: spec.provider, fields: spec.fields } };
}
/** Values stay in the caller's private closure, never returned as setup state. */
export function selectedRuntimeInputs<I extends RuntimePrivateCaseId>(ctx: ChatCatalogContext, id: I) {
  if (ctx.scenario.id !== id) throw new Error("Runtime private inputs belong to a different selected case");
  const spec = runtimePrivateRequirements[id];
  const config = ctx.input.privateInputs?.configuration("external-provider") as { schemaVersion?: number; providers?: Record<string, {
    disposable?: boolean; resourceIds?: string[]; prerequisites?: Record<string, string> }> } | undefined;
  const binding = config?.schemaVersion === 1 ? config.providers?.[spec.provider] : undefined;
  if (!binding || binding.disposable !== true || !binding.resourceIds?.length || !binding.prerequisites
    || spec.fields.some(field => !binding.prerequisites?.[field]))
    throw new Error(`Setup blocker ${id}: selected disposable ${spec.provider} inputs require ${spec.fields.join(", ")}; values withheld`);
  for (const credential of spec.credentials) if (!ctx.input.privateInputs?.credentials[credential])
    throw new Error(`Setup blocker ${id}: missing declared selected credential ${credential}`);
  const values = Object.fromEntries(spec.fields.map(field => [field, binding.prerequisites![field]!])) as Record<typeof spec.fields[number], string>;
  return { values, resourceIds: binding.resourceIds, credentials: ctx.input.privateInputs!.credentials,
    reference(name: string) { const value = ctx.input.privateInputs?.read(name); if (!value) throw new Error(`Selected runtime reference ${name} is unavailable`); return value; } };
}
export function sshPinnedHost(input: { hostname: string; port: string; knownHosts: string; hostKeySha256: string; allowedRemoteRoot: string; login: string }) {
  const port = Number(input.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !input.hostname || /[\s\r\n]/.test(input.hostname)
    || !/^[a-zA-Z0-9_.-]+$/.test(input.login) || !input.allowedRemoteRoot.startsWith("/")
    || input.allowedRemoteRoot.split("/").includes("..")
    || ["/", "/home", "/root", "/tmp", "/var", "/usr", "/etc"].includes(input.allowedRemoteRoot.replace(/\/+$/, "") || "/")) return false;
  const host = port === 22 ? input.hostname : `[${input.hostname}]:${port}`;
  const lines = input.knownHosts.trim().split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
  return lines.length === 1 && lines.every(line => {
    const [hosts, kind, encoded] = line.trim().split(/\s+/);
    if (hosts !== host || !kind || !/^(?:ssh-|ecdsa-)/.test(kind) || !encoded) return false;
    const bytes = Buffer.from(encoded, "base64"); if (!bytes.length) return false;
    const fingerprint = `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
    return fingerprint === input.hostKeySha256;
  });
}
