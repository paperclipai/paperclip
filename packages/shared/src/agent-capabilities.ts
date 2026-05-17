import { z } from "zod";
import { mcpCatalogProviderSchema } from "./mcp-marketplace.js";

const envNameSchema = z.string().trim().min(1).max(120).regex(/^[A-Z_][A-Z0-9_]*$/, {
  message: "Secret names must be environment-style identifiers",
});

const capabilityRefSchema = z.string().trim().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/, {
  message: "Capability references must be stable keys, not free-form values",
});

const secretLikeValuePattern = /(?:\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*[^\s]+|\bBearer\s+[^\s]+|\b(?:sk_(?:live|test)_|sk-|gh[opsu]_|github_pat_)[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

function assertNoSecretLikeString(value: string | null | undefined, ctx: z.RefinementCtx, path: (string | number)[]) {
  if (!value) return;
  if (secretLikeValuePattern.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Capability config must reference named secrets, not include raw secret values",
      path,
    });
  }
}

export const agentCapabilityDesiredStateSchema = z.enum(["enabled", "disabled"]);
export type AgentCapabilityDesiredState = z.infer<typeof agentCapabilityDesiredStateSchema>;

export const agentCapabilityLiveStateSchema = z.enum([
  "not_installed",
  "approval_required",
  "installed",
  "connected",
  "failed",
]);
export type AgentCapabilityLiveState = z.infer<typeof agentCapabilityLiveStateSchema>;

export const agentCapabilityMcpServerSchema = z
  .object({
    id: capabilityRefSchema,
    provider: mcpCatalogProviderSchema.default("manual"),
    catalogId: z.string().trim().min(1).max(240).optional().nullable(),
    displayName: z.string().trim().min(1).max(160),
    transport: z.enum(["stdio", "streamable_http", "sse"]).default("stdio"),
    command: z.string().trim().min(1).max(1000).optional().nullable(),
    remoteUrl: z.string().trim().url().optional().nullable(),
    requiredSecretNames: z.array(envNameSchema).default([]),
    desiredState: agentCapabilityDesiredStateSchema.default("enabled"),
    liveState: agentCapabilityLiveStateSchema.default("not_installed"),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict()
  .superRefine((server, ctx) => {
    if (server.transport === "stdio" && !server.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio MCP servers must include a command",
        path: ["command"],
      });
    }
    if ((server.transport === "streamable_http" || server.transport === "sse") && !server.remoteUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote MCP servers must include remoteUrl",
        path: ["remoteUrl"],
      });
    }
    if (server.liveState !== "not_installed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Desired capability config cannot claim liveState; live connect/install requires approval-gated apply",
        path: ["liveState"],
      });
    }
    assertNoSecretLikeString(server.displayName, ctx, ["displayName"]);
    assertNoSecretLikeString(server.command, ctx, ["command"]);
    assertNoSecretLikeString(server.remoteUrl, ctx, ["remoteUrl"]);
    assertNoSecretLikeString(server.notes, ctx, ["notes"]);
    // LET-342 / LET-343: user-controlled identifiers and catalog references
    // are echoed in Apply Preview proposals (proposalIdentity hash inputs,
    // change rows, expectedEffects copy). Their character-class regexes
    // accept credential shapes like sk_live_…, ghp_…, AKIA…, AIza…, JWTs.
    // Run the raw-secret detector here so secret-shaped refs/ids fail at
    // request validation before any proposal payload is built.
    assertNoSecretLikeString(server.id, ctx, ["id"]);
    assertNoSecretLikeString(server.catalogId, ctx, ["catalogId"]);
    // requiredSecretNames must be env-style identifiers AND must not embed
    // credential-shaped values. The env-name regex alone accepts uppercase
    // alphanumerics, so a shape like "AKIA…" can pass the identifier check
    // while still being a raw credential.
    for (const [index, secretName] of server.requiredSecretNames.entries()) {
      assertNoSecretLikeString(secretName, ctx, ["requiredSecretNames", index]);
    }
  });
export type AgentCapabilityMcpServer = z.infer<typeof agentCapabilityMcpServerSchema>;

export const agentCapabilityConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    mcpServers: z.array(agentCapabilityMcpServerSchema).default([]),
    skillRefs: z.array(capabilityRefSchema).default([]),
    toolRefs: z.array(capabilityRefSchema).default([]),
    liveApply: z.literal(false).default(false),
    liveExternalActions: z.literal(false).default(false),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const [index, server] of config.mcpServers.entries()) {
      if (ids.has(server.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate MCP server id: ${server.id}`,
          path: ["mcpServers", index, "id"],
        });
      }
      ids.add(server.id);
    }
    // LET-342 / LET-343: skillRefs / toolRefs are echoed verbatim into the
    // Apply Preview proposal's change rows and expectedEffects copy. The
    // capability-ref regex permits sk_live_…, ghp_…, AKIA…, AIza…, and JWT
    // shapes, so run the raw-secret detector against each entry to fail
    // request validation before proposal generation.
    for (const [index, ref] of config.skillRefs.entries()) {
      assertNoSecretLikeString(ref, ctx, ["skillRefs", index]);
    }
    for (const [index, ref] of config.toolRefs.entries()) {
      assertNoSecretLikeString(ref, ctx, ["toolRefs", index]);
    }
  });
export type AgentCapabilityConfig = z.infer<typeof agentCapabilityConfigSchema>;
export type AgentCapabilityConfigInput = z.input<typeof agentCapabilityConfigSchema>;

export const updateAgentCapabilityConfigSchema = z.object({
  config: agentCapabilityConfigSchema,
});
export type UpdateAgentCapabilityConfig = z.infer<typeof updateAgentCapabilityConfigSchema>;

export interface AgentCapabilityAuditSummary {
  version: 1;
  mcpServerCount: number;
  mcpServerIds: string[];
  requiredSecretNames: string[];
  skillRefCount: number;
  toolRefCount: number;
  liveApply: false;
  liveExternalActions: false;
}

export interface AgentCapabilityApplyPreview {
  dryRunAvailable: true;
  requiresApprovalForLiveApply: true;
  liveApply: false;
  liveExternalActions: false;
}

export type AgentCapabilityScope = "company_default" | "agent_local";

export interface AgentCapabilitySettingsResponse {
  scope: AgentCapabilityScope;
  companyId: string;
  agentId: string | null;
  config: AgentCapabilityConfig;
  applyPreview: AgentCapabilityApplyPreview;
}

export type AgentCapabilityChangeKind = "add" | "remove" | "update";
export type AgentCapabilityChangeRiskClass = "low" | "medium" | "high";

export interface AgentCapabilityMcpServerChangeRow {
  id: string;
  kind: AgentCapabilityChangeKind;
  displayName: string;
  transport: AgentCapabilityMcpServer["transport"];
  desiredState: AgentCapabilityDesiredState;
  liveState: AgentCapabilityLiveState;
  requiredSecretNames: string[];
  missingSecretNames: string[];
  hasCommand: boolean;
  hasRemoteUrl: boolean;
  riskClass: AgentCapabilityChangeRiskClass;
  approvalRequiredForLiveApply: true;
  changedFields: string[];
}

export interface AgentCapabilityRefChangeRow {
  kind: AgentCapabilityChangeKind;
  ref: string;
  riskClass: AgentCapabilityChangeRiskClass;
}

export interface AgentCapabilityApplyPreviewMcpDiff {
  additions: AgentCapabilityMcpServerChangeRow[];
  removals: AgentCapabilityMcpServerChangeRow[];
  updates: AgentCapabilityMcpServerChangeRow[];
}

export interface AgentCapabilityApplyPreviewRefDiff {
  additions: AgentCapabilityRefChangeRow[];
  removals: AgentCapabilityRefChangeRow[];
}

export interface AgentCapabilityApplyPreviewInheritedContext {
  note: string;
  globalDefaultsAvailable: boolean;
}

export type AgentCapabilityApplyPreviewStatus = "no_op" | "changes_pending_approval";

export interface AgentCapabilityApplyPreviewProposal {
  dryRun: true;
  liveActionPerformed: false;
  liveApply: false;
  liveExternalActions: false;
  scope: AgentCapabilityScope;
  companyId: string;
  agentId: string | null;
  status: AgentCapabilityApplyPreviewStatus;
  approvalRequiredForLiveApply: boolean;
  proposalIdentity: string;
  generatedAt: string;
  copy: {
    headline: string;
    dryRunNote: string;
    safetyStatement: string;
    rollbackNote: string;
  };
  totals: {
    additions: number;
    removals: number;
    updates: number;
  };
  riskSummary: {
    highRiskCount: number;
    mediumRiskCount: number;
    lowRiskCount: number;
  };
  mcpServers: AgentCapabilityApplyPreviewMcpDiff;
  skillRefs: AgentCapabilityApplyPreviewRefDiff;
  toolRefs: AgentCapabilityApplyPreviewRefDiff;
  requiredSecretNames: string[];
  missingSecretNames: string[];
  expectedEffects: string[];
  inheritedContext: AgentCapabilityApplyPreviewInheritedContext | null;
}

export const agentCapabilityApplyPreviewRequestSchema = z
  .object({
    draftConfig: agentCapabilityConfigSchema.optional(),
    availableSecretNames: z.array(envNameSchema).optional(),
  })
  .strict();
export type AgentCapabilityApplyPreviewRequest = z.infer<typeof agentCapabilityApplyPreviewRequestSchema>;
export type AgentCapabilityApplyPreviewRequestInput = z.input<typeof agentCapabilityApplyPreviewRequestSchema>;

export interface AgentCapabilityApplyPreviewInput {
  scope: AgentCapabilityScope;
  companyId: string;
  agentId: string | null;
  currentConfig: AgentCapabilityConfig;
  draftConfig: AgentCapabilityConfig;
  availableSecretNames?: readonly string[];
  globalDefaultsAvailable?: boolean;
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i))) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

function sanitizedMcpRow(
  kind: AgentCapabilityChangeKind,
  server: AgentCapabilityMcpServer,
  availableSecrets: ReadonlySet<string>,
  changedFields: string[],
): AgentCapabilityMcpServerChangeRow {
  const missing = server.requiredSecretNames.filter((name) => !availableSecrets.has(name));
  const hasCommand = Boolean(server.command);
  const hasRemoteUrl = Boolean(server.remoteUrl);
  // Risk classification is intentionally conservative: any new or updated MCP
  // server is treated as a live-side-effect capability, since applying it
  // would run a local process (stdio) or open a network session (remote).
  // Removals downgrade risk because the apply only removes the desired entry.
  let riskClass: AgentCapabilityChangeRiskClass;
  if (kind === "remove") {
    riskClass = "low";
  } else if (server.transport === "stdio" && hasCommand) {
    riskClass = "high";
  } else if (server.transport !== "stdio" && hasRemoteUrl) {
    riskClass = "high";
  } else {
    riskClass = "medium";
  }
  return {
    id: server.id,
    kind,
    displayName: server.displayName,
    transport: server.transport,
    desiredState: server.desiredState,
    liveState: server.liveState,
    requiredSecretNames: [...server.requiredSecretNames].sort(),
    missingSecretNames: missing.sort(),
    hasCommand,
    hasRemoteUrl,
    riskClass,
    approvalRequiredForLiveApply: true,
    changedFields: [...changedFields].sort(),
  };
}

function diffMcpServerFields(prev: AgentCapabilityMcpServer, next: AgentCapabilityMcpServer): string[] {
  const fields: string[] = [];
  if (prev.displayName !== next.displayName) fields.push("displayName");
  if (prev.transport !== next.transport) fields.push("transport");
  if ((prev.command ?? null) !== (next.command ?? null)) fields.push("command");
  if ((prev.remoteUrl ?? null) !== (next.remoteUrl ?? null)) fields.push("remoteUrl");
  if (prev.desiredState !== next.desiredState) fields.push("desiredState");
  if ((prev.provider ?? "manual") !== (next.provider ?? "manual")) fields.push("provider");
  if ((prev.notes ?? null) !== (next.notes ?? null)) fields.push("notes");
  const prevSecrets = [...prev.requiredSecretNames].sort().join("");
  const nextSecrets = [...next.requiredSecretNames].sort().join("");
  if (prevSecrets !== nextSecrets) fields.push("requiredSecretNames");
  return fields;
}

export function buildAgentCapabilityApplyPreviewProposal(
  input: AgentCapabilityApplyPreviewInput,
): AgentCapabilityApplyPreviewProposal {
  const available = new Set(input.availableSecretNames ?? []);
  const prevById = new Map(input.currentConfig.mcpServers.map((s) => [s.id, s] as const));
  const nextById = new Map(input.draftConfig.mcpServers.map((s) => [s.id, s] as const));

  const additions: AgentCapabilityMcpServerChangeRow[] = [];
  const removals: AgentCapabilityMcpServerChangeRow[] = [];
  const updates: AgentCapabilityMcpServerChangeRow[] = [];

  for (const [id, server] of nextById) {
    const prev = prevById.get(id);
    if (!prev) {
      additions.push(sanitizedMcpRow("add", server, available, []));
      continue;
    }
    const changedFields = diffMcpServerFields(prev, server);
    if (changedFields.length > 0) {
      updates.push(sanitizedMcpRow("update", server, available, changedFields));
    }
  }
  for (const [id, server] of prevById) {
    if (!nextById.has(id)) {
      removals.push(sanitizedMcpRow("remove", server, available, []));
    }
  }
  additions.sort((a, b) => a.id.localeCompare(b.id));
  removals.sort((a, b) => a.id.localeCompare(b.id));
  updates.sort((a, b) => a.id.localeCompare(b.id));

  function refDiff(
    prev: readonly string[],
    next: readonly string[],
  ): AgentCapabilityApplyPreviewRefDiff {
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    const adds: AgentCapabilityRefChangeRow[] = [];
    const removes: AgentCapabilityRefChangeRow[] = [];
    for (const ref of nextSet) {
      if (!prevSet.has(ref)) adds.push({ kind: "add", ref, riskClass: "low" });
    }
    for (const ref of prevSet) {
      if (!nextSet.has(ref)) removes.push({ kind: "remove", ref, riskClass: "low" });
    }
    adds.sort((a, b) => a.ref.localeCompare(b.ref));
    removes.sort((a, b) => a.ref.localeCompare(b.ref));
    return { additions: adds, removals: removes };
  }

  const skillRefs = refDiff(input.currentConfig.skillRefs, input.draftConfig.skillRefs);
  const toolRefs = refDiff(input.currentConfig.toolRefs, input.draftConfig.toolRefs);

  const totalAdditions = additions.length + skillRefs.additions.length + toolRefs.additions.length;
  const totalRemovals = removals.length + skillRefs.removals.length + toolRefs.removals.length;
  const totalUpdates = updates.length;

  const allMcpRows = [...additions, ...updates, ...removals];
  let highRiskCount = 0;
  let mediumRiskCount = 0;
  let lowRiskCount = 0;
  for (const row of allMcpRows) {
    if (row.riskClass === "high") highRiskCount++;
    else if (row.riskClass === "medium") mediumRiskCount++;
    else lowRiskCount++;
  }
  for (const row of [...skillRefs.additions, ...skillRefs.removals, ...toolRefs.additions, ...toolRefs.removals]) {
    if (row.riskClass === "low") lowRiskCount++;
  }

  const requiredSecretNames = Array.from(
    new Set(input.draftConfig.mcpServers.flatMap((s) => s.requiredSecretNames)),
  ).sort();
  const missingSecretNames = requiredSecretNames.filter((name) => !available.has(name));

  const status: AgentCapabilityApplyPreviewStatus =
    totalAdditions === 0 && totalRemovals === 0 && totalUpdates === 0 ? "no_op" : "changes_pending_approval";
  const approvalRequiredForLiveApply = status !== "no_op";

  const expectedEffects: string[] = [];
  if (status === "no_op") {
    expectedEffects.push(
      "Desired config is already aligned with the draft. No live MCP install, connect, execute, apply, or external action would occur on approval.",
    );
  } else {
    for (const row of additions) {
      expectedEffects.push(
        `Would record desired MCP server "${row.id}" (${row.transport}). Live install/connect/execute remains approval-gated; no live action occurs from this preview.`,
      );
    }
    for (const row of updates) {
      expectedEffects.push(
        `Would update desired MCP server "${row.id}" (changed: ${row.changedFields.join(", ") || "metadata"}). Live re-connect/install remains approval-gated.`,
      );
    }
    for (const row of removals) {
      expectedEffects.push(
        `Would remove desired MCP server "${row.id}" from this scope. No external connection is severed by this preview.`,
      );
    }
    for (const row of skillRefs.additions) {
      expectedEffects.push(`Would add skill reference "${row.ref}". Approval-gated for activation.`);
    }
    for (const row of skillRefs.removals) {
      expectedEffects.push(`Would remove skill reference "${row.ref}".`);
    }
    for (const row of toolRefs.additions) {
      expectedEffects.push(`Would add tool reference "${row.ref}". Approval-gated for activation.`);
    }
    for (const row of toolRefs.removals) {
      expectedEffects.push(`Would remove tool reference "${row.ref}".`);
    }
  }

  const inheritedContext: AgentCapabilityApplyPreviewInheritedContext | null =
    input.scope === "agent_local"
      ? {
          note:
            input.globalDefaultsAvailable === false
              ? "No global defaults available; agent-local desired config is the only authoritative source."
              : "Per-category inheritance applies in the Effective Preview: empty local categories fall back to company defaults.",
          globalDefaultsAvailable: input.globalDefaultsAvailable ?? false,
        }
      : null;

  const copy = {
    headline:
      status === "no_op"
        ? "Apply Preview — dry-run, no changes detected"
        : "Apply Preview — dry-run, changes pending approval",
    dryRunNote:
      "Dry-run only. No live MCP install, connect, execute, apply, or external action occurred from this preview.",
    safetyStatement:
      "Desired-vs-live: this preview describes desired config changes. Live apply, install, connect, execute, and external actions remain approval-gated and are not performed by this endpoint.",
    rollbackNote:
      "If an approved live apply later proceeds, rollback consists of saving the prior desired config and re-running approval-gated apply.",
  };

  const identitySource = {
    scope: input.scope,
    companyId: input.companyId,
    agentId: input.agentId,
    additions: additions.map((row) => ({
      id: row.id,
      kind: row.kind,
      transport: row.transport,
      desiredState: row.desiredState,
      requiredSecretNames: row.requiredSecretNames,
      changedFields: row.changedFields,
    })),
    removals: removals.map((row) => ({ id: row.id, kind: row.kind })),
    updates: updates.map((row) => ({
      id: row.id,
      kind: row.kind,
      transport: row.transport,
      desiredState: row.desiredState,
      requiredSecretNames: row.requiredSecretNames,
      changedFields: row.changedFields,
    })),
    skillRefs: {
      additions: skillRefs.additions.map((r) => r.ref),
      removals: skillRefs.removals.map((r) => r.ref),
    },
    toolRefs: {
      additions: toolRefs.additions.map((r) => r.ref),
      removals: toolRefs.removals.map((r) => r.ref),
    },
    missingSecretNames,
  };
  const proposalIdentity = `acp1:${fnv1a64Hex(canonicalJsonStringify(identitySource))}`;

  return {
    dryRun: true,
    liveActionPerformed: false,
    liveApply: false,
    liveExternalActions: false,
    scope: input.scope,
    companyId: input.companyId,
    agentId: input.agentId,
    status,
    approvalRequiredForLiveApply,
    proposalIdentity,
    generatedAt: new Date().toISOString(),
    copy,
    totals: {
      additions: totalAdditions,
      removals: totalRemovals,
      updates: totalUpdates,
    },
    riskSummary: {
      highRiskCount,
      mediumRiskCount,
      lowRiskCount,
    },
    mcpServers: { additions, removals, updates },
    skillRefs,
    toolRefs,
    requiredSecretNames,
    missingSecretNames,
    expectedEffects,
    inheritedContext,
  };
}

export function parseAgentCapabilityConfig(value: unknown): AgentCapabilityConfig {
  return agentCapabilityConfigSchema.parse(value ?? {});
}

export function resolveAgentCapabilityConfigForCreate(
  explicitConfig: unknown,
  companyDefaults: unknown,
): AgentCapabilityConfig {
  return parseAgentCapabilityConfig(explicitConfig ?? companyDefaults ?? {});
}

export function buildAgentCapabilityAuditSummary(config: AgentCapabilityConfig): AgentCapabilityAuditSummary {
  return {
    version: 1,
    mcpServerCount: config.mcpServers.length,
    mcpServerIds: config.mcpServers.map((server) => server.id),
    requiredSecretNames: Array.from(new Set(config.mcpServers.flatMap((server) => server.requiredSecretNames))).sort(),
    skillRefCount: config.skillRefs.length,
    toolRefCount: config.toolRefs.length,
    liveApply: false,
    liveExternalActions: false,
  };
}

export function buildAgentCapabilityApplyPreview(): AgentCapabilityApplyPreview {
  return {
    dryRunAvailable: true,
    requiresApprovalForLiveApply: true,
    liveApply: false,
    liveExternalActions: false,
  };
}
