import type { SandboxProvider } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { createCloudflareSandboxProvider } from "@paperclipai/sandbox-provider-cloudflare";
import { createE2BSandboxProvider } from "@paperclipai/sandbox-provider-e2b";
import { createOpenSandboxProvider } from "@paperclipai/sandbox-provider-opensandbox";

export type SandboxProviderType = "cloudflare" | "e2b" | "opensandbox";

let sandboxProviderFactoryForTests:
  | ((config: Record<string, unknown>) => SandboxProvider)
  | null = null;

export function setSandboxProviderFactoryForTests(
  factory: ((config: Record<string, unknown>) => SandboxProvider) | null,
) {
  sandboxProviderFactoryForTests = factory;
}

export function readSandboxProviderType(config: Record<string, unknown>): SandboxProviderType {
  const providerType = asString(config.providerType, "cloudflare").trim().toLowerCase() || "cloudflare";
  if (providerType === "cloudflare" || providerType === "e2b" || providerType === "opensandbox") {
    return providerType;
  }
  throw new Error(`Unsupported sandbox provider "${providerType}"`);
}

export function createSandboxProvider(config: Record<string, unknown>): SandboxProvider {
  if (sandboxProviderFactoryForTests) return sandboxProviderFactoryForTests(config);

  const providerType = readSandboxProviderType(config);
  if (providerType === "cloudflare") return createCloudflareSandboxProvider(config);
  if (providerType === "e2b") return createE2BSandboxProvider(config);
  return createOpenSandboxProvider(config);
}

export function describeSandboxProvider(providerType: SandboxProviderType) {
  if (providerType === "cloudflare") return "Cloudflare Sandbox";
  if (providerType === "e2b") return "E2B";
  return "OpenSandbox";
}
