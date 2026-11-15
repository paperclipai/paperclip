import { REFUSED_HOSTS, TEST_HOST_PATTERN } from "../../tests/restart-chaos/hosted-guard.ts";

export const TARGET_KINDS = ["local", "test-stack", "shared-staging", "production"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface Target {
  baseUrl: string;
  host: string;
  kind: TargetKind;
}

export class TargetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetRefused";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RESERVED_LABELS = new Set(["admin", "admin-staging", "my", "my-staging", "api", "cloud", "www", "app"]);

export function classifyHost(host: string): TargetKind {
  const lower = host.toLowerCase();
  if (LOCAL_HOSTS.has(lower) || lower.endsWith(".localhost")) return "local";
  if (REFUSED_HOSTS.has(lower)) return "shared-staging";
  if (TEST_HOST_PATTERN.test(lower) && !RESERVED_LABELS.has(lower.split(".")[0]!)) return "test-stack";
  return "production";
}

export interface TargetInput {
  baseUrl: string | undefined;
  kind: string | undefined;
  allowSharedStaging: boolean;
  allowProductionHost: string | undefined;
}

export function resolveTarget(input: TargetInput): Target {
  if (!input.baseUrl) throw new TargetRefused("Set the target with --base-url <origin> or PAPERCLIP_SCALE_BASE_URL");
  if (!input.kind) throw new TargetRefused(`--target-kind is required: one of ${TARGET_KINDS.join(", ")}`);
  if (!(TARGET_KINDS as readonly string[]).includes(input.kind)) {
    throw new TargetRefused(`--target-kind ${input.kind} is not one of ${TARGET_KINDS.join(", ")}`);
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new TargetRefused("The base URL is not a valid URL");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TargetRefused("The base URL must be a bare origin, with no path, query or credentials");
  }
  const host = url.hostname.toLowerCase();
  const kind = classifyHost(host);
  if (kind !== input.kind) {
    throw new TargetRefused(`${host} looks like a ${kind} host, not ${input.kind}; refusing`);
  }
  if (kind !== "local" && url.protocol !== "https:") throw new TargetRefused("A hosted target must use https");
  if (kind !== "local" && url.port) throw new TargetRefused("A hosted target must not name a port");
  if (kind === "shared-staging" && !input.allowSharedStaging) {
    throw new TargetRefused(`${host} is the shared staging instance; it needs the owner's go-ahead and --allow-shared-staging`);
  }
  if (kind === "production" && input.allowProductionHost?.toLowerCase() !== host) {
    throw new TargetRefused(`${host} looks like a production host; refusing unless --allow-production-host ${host} is also given`);
  }
  return { baseUrl: url.origin, host, kind };
}

export function assertSameOrigin(target: Target, url: string): void {
  if (new URL(url).origin !== target.baseUrl) throw new TargetRefused(`Refusing a request outside ${target.baseUrl}`);
}
