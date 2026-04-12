import type { BindMode, DeploymentExposure, DeploymentMode } from "./constants.js";

export const LOOPBACK_BIND_HOST = "127.0.0.1";
export const ALL_INTERFACES_BIND_HOST = "0.0.0.0";

function normalizeHost(host: string | null | undefined): string | undefined {
  const trimmed = host?.trim();
  return trimmed ? trimmed : undefined;
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host)?.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function isAllInterfacesHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host)?.toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

export function inferBindModeFromHost(
  host: string | null | undefined,
  opts?: { tailnetBindHost?: string | null | undefined },
): BindMode {
  const normalized = normalizeHost(host);
  const tailnetBindHost = normalizeHost(opts?.tailnetBindHost);

  if (!normalized || isLoopbackHost(normalized)) return "loopback";
  if (isAllInterfacesHost(normalized)) return "lan";
  if (tailnetBindHost && normalized === tailnetBindHost) return "tailnet";
  return "custom";
}

export function validateConfiguredBindMode(input: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bind?: BindMode | null | undefined;
  host?: string | null | undefined;
  customBindHost?: string | null | undefined;
}): string[] {
  const bind = input.bind ?? inferBindModeFromHost(input.host);
  const customBindHost = normalizeHost(input.customBindHost);
  const errors: string[] = [];

  if (input.deploymentMode === "local_trusted" && bind !== "loopback") {
    errors.push("local_trusted requires server.bind=loopback");
  }

  if (bind === "custom" && !customBindHost) {
    const legacyHost = normalizeHost(input.host);
    if (!legacyHost || isLoopbackHost(legacyHost) || isAllInterfacesHost(legacyHost)) {
      errors.push("server.customBindHost is required when server.bind=custom");
    }
  }

  if (input.deploymentMode === "authenticated" && input.deploymentExposure === "public" && bind === "tailnet") {
    errors.push("server.bind=tailnet is only supported for authenticated/private deployments");
  }

  return errors;
}

export function resolveRuntimeBind(input: {
  bind?: BindMode | null | undefined;
  host?: string | null | undefined;
  customBindHost?: string | null | undefined;
  tailnetBindHost?: string | null | undefined;
}): {
  bind: BindMode;
  host: string;
  customBindHost?: string;
  errors: string[];
} {
  const bind = input.bind ?? inferBindModeFromHost(input.host, { tailnetBindHost: input.tailnetBindHost });
  const legacyHost = normalizeHost(input.host);
  const customBindHost =
    normalizeHost(input.customBindHost) ??
    (bind === "custom" && legacyHost && !isLoopbackHost(legacyHost) && !isAllInterfacesHost(legacyHost)
      ? legacyHost
      : undefined);

  switch (bind) {
    case "loopback":
      return { bind, host: LOOPBACK_BIND_HOST, customBindHost, errors: [] };
    case "lan":
      return { bind, host: ALL_INTERFACES_BIND_HOST, customBindHost, errors: [] };
    case "custom":
      return customBindHost
        ? { bind, host: customBindHost, customBindHost, errors: [] }
        : { bind, host: legacyHost ?? LOOPBACK_BIND_HOST, errors: ["server.customBindHost is required when server.bind=custom"] };
    case "tailnet": {
      const tailnetBindHost = normalizeHost(input.tailnetBindHost);
      return tailnetBindHost
        ? { bind, host: tailnetBindHost, customBindHost, errors: [] }
        : {
          bind,
          host: legacyHost ?? LOOPBACK_BIND_HOST,
          customBindHost,
          errors: [
            "server.bind=tailnet requires a detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
          ],
        };
    }
  }
}
