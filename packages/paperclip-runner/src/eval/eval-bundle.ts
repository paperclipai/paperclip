import { createHash } from "node:crypto";

/**
 * A versioned candidate bundle for the runner eval vertical slice.
 *
 * A bundle declares every reproducibility input for one evaluated candidate —
 * provider/runtime, model, launch context, prompt policy, grants, runner, and
 * control-plane adapter — plus any deterministic fault injection. Two runs with
 * the same {@link bundleId} were driven by the same declared configuration, so a
 * scorecard is only comparable against another scorecard carrying the same id.
 *
 * The bundle is a *declaration*, not a live secret store: it must never carry a
 * credential, hidden company identifier, or raw secret payload. Grants are typed
 * canonical claim strings (`domain:action` or `domain:resource:action`), not
 * secret material. Callers should
 * run {@link assertBundleSecretFree} before persisting a bundle as evidence.
 */
export const EVAL_BUNDLE_SCHEMA = "paperclip.runner.eval-bundle.v1" as const;

export interface EvalBundleProvider {
  /** Session runtime that owns the provider process, e.g. `runnerd`. */
  runtime: string;
  /** Wire transport to the provider, e.g. `codex-app-server`. */
  transport: string;
  /** Negotiated provider protocol/capability version. */
  protocolVersion: string;
}

export interface EvalBundleModel {
  /** Provider model id, e.g. `gpt-5-codex`. */
  id: string;
  reasoningEffort?: string;
  temperature?: number;
}

export interface EvalBundleLaunchContext {
  /**
   * Class of working directory the candidate launched into. A *class*, never an
   * absolute host path — absolute paths can leak usernames and layout secrets.
   */
  workingDirectoryClass: "ephemeral-fixture" | "workspace-checkout" | "clean-room";
  scenarioId: string;
  turnTimeoutMs: number;
}

export interface EvalBundlePromptPolicy {
  id: string;
  /** Prompt template used when a semantic call is required. */
  callTemplate: string;
  /** Prompt template used when restraint (no call) is the correct behavior. */
  restraintTemplate: string;
}

export interface EvalBundleRunner {
  /** Runner package, e.g. `@paperclipai/paperclip-runner`. */
  package: string;
  /** Runner binary that hosts the provider session, e.g. `paperclip-runnerd`. */
  binary: string;
  version: string;
}

export interface EvalBundleControlPlaneAdapter {
  kind: "mock" | "live";
  /** Adapter contract/schema id the observations are normalized against. */
  contract: string;
}

export type EvalFaultClass =
  | "authorization"
  | "conflict"
  | "retry"
  | "provider_capability";

export interface EvalBundleFaultInjection {
  id: string;
  class: EvalFaultClass;
  description: string;
}

export interface EvalBundle {
  schema: typeof EVAL_BUNDLE_SCHEMA;
  provider: EvalBundleProvider;
  model: EvalBundleModel;
  launchContext: EvalBundleLaunchContext;
  promptPolicy: EvalBundlePromptPolicy;
  /** Typed canonical claim strings unlocked for the candidate. */
  grants: string[];
  runner: EvalBundleRunner;
  controlPlaneAdapter: EvalBundleControlPlaneAdapter;
  /** Deterministic faults injected for this candidate; empty for a clean run. */
  faultInjection: EvalBundleFaultInjection[];
}

export class EvalBundleSecretError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "EvalBundleSecretError";
  }
}

/** Stable, key-sorted JSON so the bundle id is independent of field order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Deterministic content-addressed id for a bundle. Same declared configuration
 * (in any field order) always yields the same id; any change yields a new one.
 */
export function bundleId(bundle: EvalBundle): string {
  const digest = createHash("sha256").update(canonicalJson(bundle)).digest("hex");
  return `evb-${digest.slice(0, 16)}`;
}

/** Object keys that must never appear in a declared bundle. */
const FORBIDDEN_KEY = /(^|[-_])(api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|authorization|bearer|session[-_]?token)($|[-_])/i;

/** Value shapes that look like leaked credentials regardless of their key. */
const SECRET_VALUE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "openai-key", pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "jwt", pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "pem-block", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
];

/**
 * Throws {@link EvalBundleSecretError} if the bundle carries a secret-shaped key
 * or value, or an untyped grant. Run this before persisting a bundle so a
 * candidate declaration can be safely committed as inspectable evidence.
 */
export function assertBundleSecretFree(bundle: EvalBundle): void {
  for (const grant of bundle.grants) {
    if (!/^[a-z0-9_]+(?::[a-z0-9_]+){1,2}$/.test(grant)) {
      throw new EvalBundleSecretError(
        `grant "${grant}" is not a typed canonical capability claim`,
        "grants",
      );
    }
  }
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      for (const { id, pattern } of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          throw new EvalBundleSecretError(`bundle value at ${path} looks like a ${id}`, path);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEY.test(key)) {
          throw new EvalBundleSecretError(`bundle carries forbidden key "${key}" at ${path}`, `${path}.${key}`);
        }
        visit(entry, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(bundle, "");
}

/** A redacted, one-line human description safe to print in a report header. */
export function describeBundle(bundle: EvalBundle): { bundleId: string; summary: string } {
  const faults = bundle.faultInjection.length === 0
    ? "clean"
    : bundle.faultInjection.map((fault) => fault.class).join("+");
  return {
    bundleId: bundleId(bundle),
    summary: [
      `${bundle.provider.runtime}/${bundle.provider.transport}@${bundle.provider.protocolVersion}`,
      bundle.model.id,
      bundle.controlPlaneAdapter.kind,
      `${bundle.grants.length} grants`,
      `prompt:${bundle.promptPolicy.id}`,
      `faults:${faults}`,
    ].join(" · "),
  };
}
