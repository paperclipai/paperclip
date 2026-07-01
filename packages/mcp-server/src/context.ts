/**
 * Request-scoped actor context + per-tool authorization for the MCP server.
 *
 * Historically each tool resolved its target company by falling back to a
 * process-start default (`PAPERCLIP_COMPANY_ID` / the token binding) and then
 * forwarded the call to the REST API, trusting the route-layer
 * `assertCompanyAccess` as the *sole* authorization boundary. The MCP layer had
 * no opinion of its own: a credential pinned to company A could ask a tool to
 * operate on company B and the server would happily proxy it, relying entirely
 * on the downstream route to say no.
 *
 * `RequestContext` makes the authenticated actor a first-class, request-scoped
 * value that is threaded into every tool's `execute(input, context)`. It both
 * resolves the effective company/agent for a call AND asserts, at the MCP
 * layer, that the actor is allowed to touch the resolved company — defense in
 * depth in front of the REST route (mirrors `assertCompanyAccess` for an
 * agent-scoped credential).
 *
 * On AsyncLocalStorage: the HTTP transport already builds a fresh server +
 * client per request (`runHttp` calls `buildServer(config)` for each socket),
 * so the actor context is naturally isolated per request without ALS. We derive
 * the context from that per-request config and pass it explicitly, which keeps
 * the authorization decision a pure, unit-testable function rather than ambient
 * process state.
 */
import type { PaperclipMcpConfig } from "./config.js";

/** Raised when a company-pinned actor tries to reach a different company. */
export class CompanyAccessError extends Error {
  readonly boundCompanyId: string;
  readonly requestedCompanyId: string;

  constructor(boundCompanyId: string, requestedCompanyId: string) {
    super(
      `Actor is bound to company ${boundCompanyId} and cannot access company ${requestedCompanyId}`,
    );
    this.name = "CompanyAccessError";
    this.boundCompanyId = boundCompanyId;
    this.requestedCompanyId = requestedCompanyId;
  }
}

export interface RequestContextInit {
  companyId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}

function normalize(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The resolved identity of the caller for a single MCP invocation. In stdio
 * mode it is derived once from the process environment; in http mode it is
 * derived from the per-request bearer-token binding.
 */
export class RequestContext {
  /** The company the presenting credential is pinned to, or null if unpinned. */
  readonly companyId: string | null;
  /** The agent the presenting credential is pinned to, or null if unpinned. */
  readonly agentId: string | null;
  /** The originating run id, propagated to write requests. */
  readonly runId: string | null;

  constructor(init: RequestContextInit = {}) {
    this.companyId = normalize(init.companyId);
    this.agentId = normalize(init.agentId);
    this.runId = normalize(init.runId);
  }

  static fromConfig(
    config: Pick<PaperclipMcpConfig, "companyId" | "agentId" | "runId">,
  ): RequestContext {
    return new RequestContext(config);
  }

  /**
   * Assert the actor may operate on `companyId`. A credential pinned to a
   * company may only touch that company; an unpinned credential (no bound
   * company — e.g. an instance-admin token) defers to the REST route's own
   * `assertCompanyAccess`.
   */
  assertCompanyAccess(companyId: string): void {
    if (this.companyId && this.companyId !== companyId) {
      throw new CompanyAccessError(this.companyId, companyId);
    }
  }

  /**
   * Resolve the effective company for a call (explicit input, else the bound
   * default) and assert the actor is allowed to reach it.
   */
  resolveCompanyId(requested?: string | null): string {
    const resolved = normalize(requested) ?? this.companyId;
    if (!resolved) {
      throw new Error(
        "companyId is required because the actor has no bound company (PAPERCLIP_COMPANY_ID / token binding is unset)",
      );
    }
    this.assertCompanyAccess(resolved);
    return resolved;
  }

  /** Resolve the effective agent for a call (explicit input, else the bound default). */
  resolveAgentId(requested?: string | null): string {
    const resolved = normalize(requested) ?? this.agentId;
    if (!resolved) {
      throw new Error(
        "agentId is required because the actor has no bound agent (PAPERCLIP_AGENT_ID / token binding is unset)",
      );
    }
    return resolved;
  }
}

/**
 * Best-effort authorization for the generic `paperclipApiRequest` escape hatch:
 * if the path is company-scoped (`/companies/<id>/...`), assert the actor may
 * reach that company before proxying. Non-company paths (issue/approval/goal
 * keyed) fall through to the REST route's own checks.
 */
const COMPANY_SCOPED_PATH = /^\/companies\/([^/?#]+)/;

export function assertPathCompanyAccess(context: RequestContext, path: string): void {
  const match = COMPANY_SCOPED_PATH.exec(path);
  if (!match) return;
  const companyId = decodeURIComponent(match[1]);
  context.assertCompanyAccess(companyId);
}
