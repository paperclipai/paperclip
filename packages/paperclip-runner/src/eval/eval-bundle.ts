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
 * The bundle is a *declaration*, not a secret store: it must never carry a
 * credential, hidden company identifier, or raw secret payload. Grants are typed
 * canonical claim strings (`domain:action` or `domain:resource:action`), not
 * secret material. Callers should
 * run {@link assertBundleSecretFree} before use and persist only the digested
 * record returned by {@link bundleEvidenceDeclaration}.
 */
export const EVAL_BUNDLE_SCHEMA = "paperclip.runner.eval-bundle.v1" as const;
export const EVAL_BUNDLE_EVIDENCE_SCHEMA =
  "paperclip.runner.eval-bundle-evidence.v1" as const;

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
  kind: "mock";
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

/**
 * Persistable bundle evidence. Free-form declaration strings are represented by
 * content digests so report artifacts cannot become an accidental secret store.
 */
export interface EvalBundleEvidenceDeclaration {
  schema: typeof EVAL_BUNDLE_EVIDENCE_SCHEMA;
  sourceSchema: typeof EVAL_BUNDLE_SCHEMA;
  contentSha256: string;
  provider: {
    runtimeSha256: string;
    transportSha256: string;
    protocolVersionSha256: string;
  };
  model: {
    idSha256: string;
    reasoningEffortSha256?: string;
    temperature?: number;
  };
  launchContext: {
    workingDirectoryClassSha256: string;
    scenarioIdSha256: string;
    turnTimeoutMs: number;
  };
  promptPolicy: {
    idSha256: string;
    callTemplateSha256: string;
    restraintTemplateSha256: string;
  };
  grants: { count: number; claimsSha256: string };
  runner: {
    packageSha256: string;
    binarySha256: string;
    versionSha256: string;
  };
  controlPlaneAdapter: { kind: "mock"; contractSha256: string };
  faultInjection: { count: number; declarationSha256: string };
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

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Object keys that must never appear in a declared bundle. */
const FORBIDDEN_KEY = /(^|[-_])(api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|authorization|bearer|session[-_]?token)($|[-_])/i;

/** Value shapes that look like leaked credentials regardless of their key. */
const SECRET_VALUE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "provider-key", pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/ },
  { id: "stripe-live-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{12,}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { id: "pypi-token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/ },
  { id: "bearer-token", pattern: /\bBearer\s+[^\s"'`]{12,}/i },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "jwt", pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "pem-block", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  {
    id: "credential-assignment",
    pattern: /\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|session[-_]?token|token|authorization|bearer|secret|password|passwd|credential|private[-_]?key)\s*(?:=|:)\s*["']?[^\s"'`,}]{8,}/i,
  },
  {
    id: "json-credential-field",
    pattern: /"(?:api[-_]?key|access[-_]?token|auth[-_]?token|session[-_]?token|token|authorization|bearer|secret|password|passwd|credential|private[-_]?key)"\s*:\s*"[^"\\]{4,}/i,
  },
  {
    id: "escaped-json-credential-field",
    pattern: /\\"(?:api[-_]?key|access[-_]?token|auth[-_]?token|session[-_]?token|token|authorization|bearer|secret|password|passwd|credential|private[-_]?key)\\"\s*:\s*\\"(?:\\\\.|[^"\\]){4,}/i,
  },
];

/**
 * Central fail-closed scanner for eval inputs and serialized evidence. Error
 * messages identify only the pattern and location; rejected content is never
 * echoed back into logs.
 */
export function assertEvalArtifactSecretFree(
  value: unknown,
  rootPath = "eval artifact",
): void {
  const visit = (entry: unknown, path: string): void => {
    if (typeof entry === "string") {
      for (const { id, pattern } of SECRET_VALUE_PATTERNS) {
        if (pattern.test(entry)) {
          throw new EvalBundleSecretError(
            `secret-shaped ${id} detected at ${path}`,
            path,
          );
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof entry === "object" && entry !== null) {
      for (const [key, child] of Object.entries(entry)) {
        const childPath = `${path}.${key}`;
        if (FORBIDDEN_KEY.test(key)) {
          throw new EvalBundleSecretError(
            `forbidden credential field detected at ${childPath}`,
            childPath,
          );
        }
        visit(child, childPath);
      }
    }
  };
  visit(value, rootPath);
}

/**
 * Throws {@link EvalBundleSecretError} if the bundle carries a secret-shaped key
 * or value, or an untyped grant. Persist the output of
 * {@link bundleEvidenceDeclaration}, never the input bundle itself.
 */
export function assertBundleSecretFree(bundle: EvalBundle): void {
  assertEvalArtifactSecretFree(bundle, "bundle");
  for (const [index, grant] of bundle.grants.entries()) {
    if (!/^[a-z0-9_]+(?::[a-z0-9_]+){1,2}$/.test(grant)) {
      throw new EvalBundleSecretError(
        `grant at grants[${index}] is not a typed canonical capability claim`,
        `grants[${index}]`,
      );
    }
  }
}

/** Convert a validated bundle into an explicit, free-form-content-free record. */
export function bundleEvidenceDeclaration(
  bundle: EvalBundle,
): EvalBundleEvidenceDeclaration {
  assertBundleSecretFree(bundle);
  return {
    schema: EVAL_BUNDLE_EVIDENCE_SCHEMA,
    sourceSchema: EVAL_BUNDLE_SCHEMA,
    contentSha256: sha256(bundle),
    provider: {
      runtimeSha256: sha256(bundle.provider.runtime),
      transportSha256: sha256(bundle.provider.transport),
      protocolVersionSha256: sha256(bundle.provider.protocolVersion),
    },
    model: {
      idSha256: sha256(bundle.model.id),
      ...(bundle.model.reasoningEffort === undefined
        ? {}
        : { reasoningEffortSha256: sha256(bundle.model.reasoningEffort) }),
      ...(bundle.model.temperature === undefined
        ? {}
        : { temperature: bundle.model.temperature }),
    },
    launchContext: {
      workingDirectoryClassSha256: sha256(bundle.launchContext.workingDirectoryClass),
      scenarioIdSha256: sha256(bundle.launchContext.scenarioId),
      turnTimeoutMs: bundle.launchContext.turnTimeoutMs,
    },
    promptPolicy: {
      idSha256: sha256(bundle.promptPolicy.id),
      callTemplateSha256: sha256(bundle.promptPolicy.callTemplate),
      restraintTemplateSha256: sha256(bundle.promptPolicy.restraintTemplate),
    },
    grants: {
      count: bundle.grants.length,
      claimsSha256: sha256(bundle.grants),
    },
    runner: {
      packageSha256: sha256(bundle.runner.package),
      binarySha256: sha256(bundle.runner.binary),
      versionSha256: sha256(bundle.runner.version),
    },
    controlPlaneAdapter: {
      kind: "mock",
      contractSha256: sha256(bundle.controlPlaneAdapter.contract),
    },
    faultInjection: {
      count: bundle.faultInjection.length,
      declarationSha256: sha256(bundle.faultInjection),
    },
  };
}

/** A redacted, one-line human description safe to print in a report header. */
export function describeBundle(bundle: EvalBundle): { bundleId: string; summary: string } {
  assertBundleSecretFree(bundle);
  const id = bundleId(bundle);
  return {
    bundleId: id,
    summary: `eval bundle ${id} · ${bundle.grants.length} grants · ${bundle.faultInjection.length} faults`,
  };
}
