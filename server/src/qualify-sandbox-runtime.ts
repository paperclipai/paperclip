import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalProviderPackJson, compatibleProviderPackInstallation,
  type PackProvider, type ProviderPackIdentity } from "./services/native-runtime/provider-pack-compatibility.js";

type QualificationInput = {
  installed: { manifest: ProviderPackIdentity; runnerSha256: string; immutable: boolean };
  providers?: PackProvider[];
};

export function qualifySandboxRuntime(input: QualificationInput, expected: {
  manifest: ProviderPackIdentity; runnerSha256: string;
}) {
  const providers = input?.providers ?? [{ kind: "opencode" as const },
    ...[...new Set([...Object.keys(expected.manifest?.payload?.acpxProfileDigests ?? {}),
      ...Object.keys(expected.manifest?.payload?.providers ?? {}), ...Object.keys(expected.manifest?.payload?.candidateProviders ?? {})])]
      .sort().map(agent => ({ kind: "acpx" as const, agent }))];
  if (!input || !input.installed || !input.installed.manifest ||
      typeof input.installed.manifest.schema !== "string" || typeof input.installed.manifest.digest !== "string" ||
      !input.installed.manifest.payload || typeof input.installed.manifest.payload !== "object" || Array.isArray(input.installed.manifest.payload) ||
      !Array.isArray(providers) || !providers.length || providers.length > 32 ||
      !/^[a-f0-9]{64}$/.test(input.installed.runnerSha256) || typeof input.installed.immutable !== "boolean" ||
      providers.some(provider => !provider || (provider.kind !== "opencode" &&
        (provider.kind !== "acpx" || typeof provider.agent !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider.agent))))) {
    throw new Error("Invalid sandbox runtime qualification input");
  }
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalProviderPackJson(value)).digest("hex")}`;
  if (!expected.manifest?.payload || expected.manifest.digest !== digest(expected.manifest.payload)) {
    throw new Error("Invalid expected provider-pack manifest");
  }
  let failedCheck: string | undefined;
  if (input.installed.runnerSha256 !== expected.runnerSha256) failedCheck = "runner_binary";
  for (const provider of providers) {
    if (failedCheck) break;
    try {
      compatibleProviderPackInstallation({ root: "/opt/paperclip-runner/provider-pack",
        manifest: input.installed.manifest, immutable: input.installed.immutable }, expected.manifest,
      "/opt/paperclip-runner/provider-pack", provider, false, false);
    } catch (error) {
      failedCheck = (error as { failureCheck?: string }).failureCheck ?? "provider_pack";
    }
  }
  return {
    schema: "paperclip.sandbox-runtime-qualification.v1",
    compatible: failedCheck === undefined,
    ...(failedCheck ? { failedCheck } : {}),
    expectedPackDigest: expected.manifest.digest,
    installedPackDigest: input.installed.manifest?.digest,
    runnerSha256: expected.runnerSha256,
    providers,
    allPackProviders: input.providers === undefined,
  };
}

export function runSandboxRuntimeQualification(args: string[], source: string) {
  if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--runner" || !args[1] || !args[3] ||
      Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("Invalid sandbox qualification arguments");
  const manifest = JSON.parse(readFileSync(args[1], "utf8")) as ProviderPackIdentity;
  const runnerSha256 = createHash("sha256").update(readFileSync(args[3])).digest("hex");
  return qualifySandboxRuntime(JSON.parse(source), { manifest, runnerSha256 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const report = runSandboxRuntimeQualification(process.argv.slice(2), readFileSync(0, "utf8"));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.compatible ? 0 : 2;
  } catch {
    process.stderr.write("Sandbox runtime qualification could not be completed\n");
    process.exitCode = 1;
  }
}
