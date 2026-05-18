/**
 * LET-402 / LET-140-G.4 — real MCP apply adapter (behind capability.apply.live).
 *
 * Scope and safety contract:
 *   - When `capability.apply.live` is OFF (default everywhere, including prod
 *     this slice), `getExecutorAdapter` returns `StubMcpApplyAdapter` which
 *     records "would-execute" intent only. No network, no MCP RPC, no agent
 *     config mutation.
 *   - When `capability.apply.live` is ON (local opt-in only this slice),
 *     `getExecutorAdapter` returns `RealMcpApplyAdapter`. The real adapter is
 *     deterministic, idempotent, and fails closed on:
 *       * non-allowlisted catalog ids (per LET-353 §4 verified-catalog rule),
 *       * outbound URLs that resolve to loopback / private / IMDS ranges
 *         (per LET-323 egress policy + OWASP LLM SSRF guidance),
 *       * named secret references that the resolver cannot locate.
 *   - The real adapter NEVER persists or returns raw secret values. It calls
 *     a `SecretReferenceResolver` only to verify a named secret exists in the
 *     company's vault and then discards any resolved handle. The audit record
 *     contains only references.
 *   - The real adapter does not currently mutate `agents.capability_config`
 *     or perform outbound MCP install RPC. Those are deferred to a future
 *     approval-gated rollout slice. The adapter's job in G.4 is to provide
 *     the safety-first execution surface that future slices will plug into,
 *     and to make every guard observable via the existing event ledger.
 *
 * References:
 *   - MCP Authorization 2025-06-18 + Security Best Practices 2025-06-18:
 *     the apply adapter is the "trusted client side" that resolves secrets at
 *     use time and never logs them.
 *   - OWASP Top 10 for LLM Applications: LLM06 (sensitive information
 *     disclosure) and LLM07 (insecure plugin design / SSRF) — the catalog
 *     allowlist + egress guard implement the relevant mitigations.
 *
 * No raw secret values appear in this file, its tests, its logs, its events,
 * or its return values. The only secret-shaped data the adapter sees is the
 * NAME of a secret (an env-style identifier), which the upstream schema +
 * `assertNoSecretShape` already proves is not a credential.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { logger } from "../middleware/logger.js";
import { CAPABILITY_APPLY_ERROR_CODES, type CapabilityApplyStep } from "@paperclipai/shared";

// ── Public types ─────────────────────────────────────────────────────────────

export interface McpApplyAdapterContext {
  companyId: string;
  planId: string;
}

/**
 * Result of a step apply. `wouldExecute` is preserved for parity with G.2
 * stub output. `mutationDigest` is a deterministic content-addressable hash
 * of the intent so callers (or replays) can prove idempotency without
 * persisting raw configuration.
 */
export interface McpApplyStepResult {
  wouldExecute: boolean;
  mutationDigest: string;
  stepKey: string;
}

export interface McpApplyAdapter {
  /** Identifier used for telemetry + tests; never user-facing. */
  readonly kind: "stub" | "real";
  executeStep(step: CapabilityApplyStep, ctx: McpApplyAdapterContext): Promise<McpApplyStepResult>;
}

/**
 * Verifies a named secret exists for the company. Implementations MUST NOT
 * return the raw value here; the existence-check is intentionally
 * value-blind to match the apply contract.
 */
export interface SecretReferenceResolver {
  hasNamedSecret(companyId: string, name: string): Promise<boolean>;
}

/**
 * Catalog allowlist gate. By default we accept the `verified/` prefix and any
 * explicit ids configured by the deployment, and reject everything else.
 */
export interface CatalogAllowlist {
  isAllowed(catalogId: string | undefined): boolean;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class CapabilityApplyAdapterError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ── Default catalog allowlist ────────────────────────────────────────────────

/**
 * The default allowlist: accept any catalog id beginning with `verified/`,
 * plus any explicit ids the deployment configures.
 *
 * The `verified/` prefix is the plan-builder contract (see capability-apply
 * service `createPlan` — `add_mcp_server` without a catalogId is already
 * refused with STEP_REQUIRES_GOVERNANCE). G.4 tightens this further by
 * refusing catalogs that don't pass the allowlist at execute time too — so a
 * later catalog-write that bypassed plan-time validation still fails closed.
 */
export class DefaultCatalogAllowlist implements CatalogAllowlist {
  private readonly explicit: ReadonlySet<string>;
  constructor(explicitIds: Iterable<string> = []) {
    this.explicit = new Set(explicitIds);
  }
  isAllowed(catalogId: string | undefined): boolean {
    if (!catalogId) return false;
    if (this.explicit.has(catalogId)) return true;
    return catalogId.startsWith("verified/");
  }
}

// ── SSRF / egress guard ──────────────────────────────────────────────────────

/**
 * Reject URLs that would let an MCP install/RPC reach back into the host
 * network. Mirrors the LET-323 egress policy intent, kept local so this
 * module has no dependency on the larger sandbox runtime.
 *
 * Rules:
 *   - scheme MUST be http(s)
 *   - hostname must NOT be a loopback (127/8, ::1, "localhost")
 *   - hostname must NOT be a private/link-local/reserved range
 *   - hostname must NOT be the IMDS literal (169.254.169.254 / fd00:ec2::254)
 *   - DNS-name hostnames are not pre-resolved here (resolution happens at
 *     real connect time in a future slice); this guard refuses literal
 *     numeric IPs in the forbidden ranges and rejects obvious local names.
 */
export function assertEgressAllowed(rawUrl: string | undefined | null, fieldPath: string): void {
  if (!rawUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CapabilityApplyAdapterError(
      CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
      "MCP remoteUrl is not a parseable URL",
      { field: fieldPath, reason: "invalid_url" },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CapabilityApplyAdapterError(
      CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
      "MCP remoteUrl must use http or https",
      { field: fieldPath, reason: "scheme_not_allowed", scheme: parsed.protocol },
    );
  }
  // Node returns IPv6 hostnames wrapped in brackets (`[::1]`); strip them so
  // string comparisons against bare IPv6 literals work and so `isIP` returns
  // a useful value.
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "[::]"
  ) {
    throw new CapabilityApplyAdapterError(
      CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
      "MCP remoteUrl resolves to a host-local target",
      { field: fieldPath, reason: "host_local" },
    );
  }
  if (host === "169.254.169.254" || host === "fd00:ec2::254") {
    throw new CapabilityApplyAdapterError(
      CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
      "MCP remoteUrl targets the IMDS endpoint",
      { field: fieldPath, reason: "imds" },
    );
  }
  // IPv4 forbidden ranges by leading octet / specific blocks.
  if (isIP(host) === 4) {
    const parts = host.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new CapabilityApplyAdapterError(
        CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
        "MCP remoteUrl host is not a recognisable IPv4 literal",
        { field: fieldPath, reason: "ipv4_malformed" },
      );
    }
    const [a, b] = parts;
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local incl. IMDS
      a === 0 ||
      a >= 224; // multicast + reserved
    if (isPrivate) {
      throw new CapabilityApplyAdapterError(
        CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
        "MCP remoteUrl targets a private / reserved IPv4 range",
        { field: fieldPath, reason: "ipv4_private", octet0: a },
      );
    }
  }
  // IPv6 — coarse refusal of common local/reserved markers. We avoid a full
  // IPv6 classifier here; anything inside the documented private ranges
  // (fc00::/7) or unique-local + loopback markers is refused.
  if (isIP(host) === 6) {
    if (
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    ) {
      throw new CapabilityApplyAdapterError(
        CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
        "MCP remoteUrl targets a private / link-local IPv6 range",
        { field: fieldPath, reason: "ipv6_private" },
      );
    }
  }
}

// ── Step key (saga / replay idempotency) ─────────────────────────────────────

/**
 * Deterministic per-step idempotency key. Two executions of the same step in
 * the same plan revision produce the same key, so persistence layers above
 * the adapter can detect replays without holding row locks across the whole
 * apply.
 *
 * Format: `apply:${planId}:${ordinal}:${kind}`.
 */
export function buildStepKey(planId: string, step: CapabilityApplyStep): string {
  return `apply:${planId}:${step.ordinal}:${step.kind}`;
}

/**
 * Deterministic content-addressable hash of the intent (catalog + transport +
 * sorted secret names). The hash MUST NOT include any free-form labels that
 * could leak user-typed text into telemetry.
 */
export function buildMutationDigest(step: CapabilityApplyStep): string {
  const canonical = JSON.stringify({
    catalogId: step.target.catalogId ?? null,
    kind: step.kind,
    namedSecretRefs: [...step.target.namedSecretRefs].sort(),
    transport: step.target.transport ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// ── Stub adapter (live=OFF) ─────────────────────────────────────────────────

export class StubMcpApplyAdapter implements McpApplyAdapter {
  readonly kind = "stub" as const;
  async executeStep(step: CapabilityApplyStep, ctx: McpApplyAdapterContext): Promise<McpApplyStepResult> {
    const stepKey = buildStepKey(ctx.planId, step);
    const mutationDigest = buildMutationDigest(step);
    logger.info(
      {
        planId: ctx.planId,
        companyId: ctx.companyId,
        stepKey,
        kind: step.kind,
        riskClass: step.riskClass,
        mutationDigest,
      },
      "[capability-apply][stub] would-execute event recorded (live flag OFF)",
    );
    return { wouldExecute: true, mutationDigest, stepKey };
  }
}

// ── Real adapter (live=ON, default OFF in prod) ──────────────────────────────

export interface RealMcpApplyAdapterDeps {
  catalogAllowlist?: CatalogAllowlist;
  secretReferenceResolver?: SecretReferenceResolver;
  /** Pluggable URL extractor for tests; defaults to step.target metadata. */
  getRemoteUrl?: (step: CapabilityApplyStep) => string | undefined;
}

export class RealMcpApplyAdapter implements McpApplyAdapter {
  readonly kind = "real" as const;
  private readonly catalogAllowlist: CatalogAllowlist;
  private readonly resolver: SecretReferenceResolver | null;
  private readonly getRemoteUrl: (step: CapabilityApplyStep) => string | undefined;

  constructor(deps: RealMcpApplyAdapterDeps = {}) {
    this.catalogAllowlist = deps.catalogAllowlist ?? new DefaultCatalogAllowlist();
    this.resolver = deps.secretReferenceResolver ?? null;
    this.getRemoteUrl = deps.getRemoteUrl ?? ((step) => {
      const raw = (step.target as unknown as { remoteUrl?: string | null }).remoteUrl;
      return typeof raw === "string" && raw.length > 0 ? raw : undefined;
    });
  }

  async executeStep(step: CapabilityApplyStep, ctx: McpApplyAdapterContext): Promise<McpApplyStepResult> {
    const stepKey = buildStepKey(ctx.planId, step);
    const mutationDigest = buildMutationDigest(step);

    // MCP-server steps must point at an allowlisted catalog entry. Skill /
    // tool ref steps don't go through the catalog, so they bypass this gate.
    const isMcpStep =
      step.kind === "add_mcp_server" ||
      step.kind === "update_mcp_server" ||
      step.kind === "remove_mcp_server";

    if (isMcpStep && step.kind !== "remove_mcp_server") {
      if (!this.catalogAllowlist.isAllowed(step.target.catalogId)) {
        throw new CapabilityApplyAdapterError(
          CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED,
          "MCP catalog id is not on the verified allowlist",
          { stepKey, ordinal: step.ordinal, catalogIdPresent: Boolean(step.target.catalogId) },
        );
      }
      // LET-402 G.4 hardening: a remote-transport MCP step that arrives at
      // the adapter without a remoteUrl means the apply pipeline dropped the
      // endpoint somewhere between approval and execute. Fail closed so the
      // egress guard cannot be bypassed by an omitted field.
      const remoteUrl = this.getRemoteUrl(step);
      const transport = step.target.transport;
      const requiresRemote = transport === "sse" || transport === "streamable_http";
      if (requiresRemote && !remoteUrl) {
        throw new CapabilityApplyAdapterError(
          CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
          "Remote-transport MCP step is missing remoteUrl",
          { stepKey, ordinal: step.ordinal, reason: "missing_remote_url", transport },
        );
      }
      assertEgressAllowed(remoteUrl, `step[${step.ordinal}].target.remoteUrl`);
    }

    // Verify each named secret exists. We deliberately do NOT request values.
    if (this.resolver && step.target.namedSecretRefs.length > 0) {
      for (const name of step.target.namedSecretRefs) {
        const exists = await this.resolver.hasNamedSecret(ctx.companyId, name);
        if (!exists) {
          throw new CapabilityApplyAdapterError(
            CAPABILITY_APPLY_ERROR_CODES.NAMED_SECRET_NOT_FOUND,
            "Required named secret is not present in this company's vault",
            { stepKey, ordinal: step.ordinal, secretName: name },
          );
        }
      }
    }

    logger.info(
      {
        planId: ctx.planId,
        companyId: ctx.companyId,
        stepKey,
        kind: step.kind,
        riskClass: step.riskClass,
        mutationDigest,
      },
      "[capability-apply][real] would-mutate event recorded (live flag ON, no outbound MCP yet)",
    );

    // G.4 deliberately stops short of mutating agents.capability_config or
    // issuing outbound MCP install RPC. That is reserved for a future
    // approval-gated rollout slice that will plug a real materializer in
    // here and reuse the same step-key + mutationDigest for idempotency.
    return { wouldExecute: true, mutationDigest, stepKey };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface ExecutorAdapterFactoryOpts {
  capabilityApplyLive: boolean;
  realAdapterDeps?: RealMcpApplyAdapterDeps;
}

export function getExecutorAdapter(opts: ExecutorAdapterFactoryOpts): McpApplyAdapter {
  if (opts.capabilityApplyLive) {
    return new RealMcpApplyAdapter(opts.realAdapterDeps);
  }
  return new StubMcpApplyAdapter();
}
