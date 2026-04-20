import { inferBindModeFromHost } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export function deploymentAuthCheck(config: PaperclipConfig): CheckResult {
  const mode = config.server.deploymentMode;
  const exposure = config.server.exposure;
  const auth = config.auth;
  const bind = config.server.bind ?? inferBindModeFromHost(config.server.host);

  if (mode === "local_trusted") {
    if (bind !== "loopback") {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: `local_trusted requires loopback binding (found ${bind})`,
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and choose Local trusted / loopback reachability",
      };
    }
    return {
      name: "Deployment/auth mode",
      status: "pass",
      message: "local_trusted mode is configured for loopback-only access",
    };
  }

  const secret =
    process.env.BETTER_AUTH_SECRET?.trim() ??
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!secret) {
    return {
      name: "Deployment/auth mode",
      status: "fail",
      message: "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET)",
      canRepair: false,
      repairHint: "Set BETTER_AUTH_SECRET before starting Paperclip",
    };
  }

  if (auth.baseUrlMode === "explicit" && !auth.publicBaseUrl) {
    return {
      name: "Deployment/auth mode",
      status: "fail",
      message: "auth.baseUrlMode=explicit requires auth.publicBaseUrl",
      canRepair: false,
      repairHint: "Run `paperclipai configure --section server` and provide a base URL",
    };
  }

  if (exposure === "public") {
    if (auth.baseUrlMode !== "explicit" || !auth.publicBaseUrl) {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "authenticated/public requires explicit auth.publicBaseUrl",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and select public exposure",
      };
    }
    try {
      const url = new URL(auth.publicBaseUrl);
      if (url.protocol !== "https:") {
        return {
          name: "Deployment/auth mode",
          status: "warn",
          message: "Public exposure should use an https:// auth.publicBaseUrl",
          canRepair: false,
          repairHint: "Use HTTPS in production for secure session cookies",
        };
      }
    } catch {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "auth.publicBaseUrl is not a valid URL",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and provide a valid URL",
      };
    }
  }

  return {
    name: "Deployment/auth mode",
    status: "pass",
    message: `Mode ${mode}/${exposure} with bind ${bind} and auth URL mode ${auth.baseUrlMode}`,
  };
}
