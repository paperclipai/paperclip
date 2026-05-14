import { isLoopbackHost } from "@paperclipai/shared";
import type { DeploymentExposure } from "@paperclipai/shared";

export interface ReachableUrlInput {
  /** Resolved bind host string (e.g. "127.0.0.1", "0.0.0.0"). Used instead of BindMode to correctly handle bind=custom with a loopback customBindHost. */
  bindHost: string;
  deploymentExposure: DeploymentExposure;
  authPublicBaseUrl: string | undefined;
  pathname: string;
}

export type ReachableUrlResult =
  | { url: string; reason?: never }
  | { url: null; reason: string };

export const REACHABLE_URL_REASON = {
  loopbackBind: "loopback_bind",
  privateExposure: "private_exposure",
  noPublicBaseUrl: "no_public_base_url",
  invalidBaseUrl: "invalid_base_url",
  invalidPathname: "invalid_pathname",
} as const;

export type ReachableUrlReason = (typeof REACHABLE_URL_REASON)[keyof typeof REACHABLE_URL_REASON];

const MAX_PATHNAME_LENGTH = 2048;
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+\-.]*:)?\/\//i;

export function resolveReachableUrl(input: ReachableUrlInput): ReachableUrlResult {
  const { pathname } = input;
  if (
    typeof pathname !== "string" ||
    pathname.length === 0 ||
    pathname.length > MAX_PATHNAME_LENGTH ||
    ABSOLUTE_URL_RE.test(pathname) ||
    pathname.includes("\r") ||
    pathname.includes("\n") ||
    pathname.includes("\0")
  ) {
    return { url: null, reason: REACHABLE_URL_REASON.invalidPathname };
  }

  if (isLoopbackHost(input.bindHost)) {
    return { url: null, reason: REACHABLE_URL_REASON.loopbackBind };
  }

  if (input.deploymentExposure === "private") {
    return { url: null, reason: REACHABLE_URL_REASON.privateExposure };
  }

  if (!input.authPublicBaseUrl) {
    return { url: null, reason: REACHABLE_URL_REASON.noPublicBaseUrl };
  }

  try {
    const base = new URL(input.authPublicBaseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const resolved = new URL(`${base.origin}${basePath}${suffix}`);
    return { url: resolved.toString() };
  } catch {
    return { url: null, reason: REACHABLE_URL_REASON.invalidBaseUrl };
  }
}
