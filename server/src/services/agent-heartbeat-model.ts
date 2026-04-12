import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { canonicalizeAgentRole } from "@paperclipai/shared";
import { agentInstructionsService } from "./agent-instructions.js";
import { deduplicateAgentName, agentService } from "./agents.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";

export const COO_COORDINATOR_DEFAULT_INTERVAL_SEC = 3600;
export const COO_COORDINATOR_DEFAULT_NAME = "COO";
export const COO_COORDINATOR_DEFAULT_TITLE = "COO";
export const QA_RELEASE_DEFAULT_NAME = "QA and Release Engineer";
export const QA_RELEASE_DEFAULT_TITLE = "QA and Release Engineer";

const TECH_ROLES_REQUIRING_QA = new Set(["cto", "engineer", "devops"]);

export type HeartbeatModelMode = "default" | "enforce";

type RuntimeConfigRecord = Record<string, unknown>;

type HeartbeatModelReport = {
  apply: boolean;
  scannedAgents: number;
  updatedAgents: number;
  unchangedAgents: number;
  touchedCompanyIds: string[];
};

type CooInstructionsSyncReport = {
  apply: boolean;
  scannedCooAgents: number;
  updatedAgents: number;
  unchangedAgents: number;
  skippedExternalBundles: number;
  touchedCompanyIds: string[];
  updatedAgentIds: string[];
};

type QaInstructionsSyncReport = {
  apply: boolean;
  scannedQaAgents: number;
  updatedAgents: number;
  unchangedAgents: number;
  skippedExternalBundles: number;
  touchedCompanyIds: string[];
  updatedAgentIds: string[];
};

type CooCoverageReason = "already_has_coo" | "coo_created" | "no_ceo" | "company_not_found";

type CompanyCooCoverageResult = {
  apply: boolean;
  companyId: string;
  companyName: string | null;
  created: boolean;
  reason: CooCoverageReason;
  createdAgentId: string | null;
};

export type CooCoordinatorCoverageReport = {
  apply: boolean;
  scannedCompanies: number;
  companiesWithCoordinator: number;
  companiesMissingCoordinator: number;
  companiesSkippedNoCeo: number;
  createdAgents: number;
  createdCompanyIds: string[];
};

type QaCoverageReason =
  | "already_has_qa"
  | "qa_created"
  | "no_tech_team"
  | "company_not_found";

type CompanyQaCoverageResult = {
  apply: boolean;
  companyId: string;
  companyName: string | null;
  created: boolean;
  reason: QaCoverageReason;
  createdAgentId: string | null;
};

export type QaReleaseCoverageReport = {
  apply: boolean;
  scannedCompanies: number;
  companiesWithQa: number;
  companiesWithTechTeam: number;
  companiesMissingQa: number;
  companiesSkippedNoTechTeam: number;
  createdAgents: number;
  createdCompanyIds: string[];
};

function isRecord(value: unknown): value is RuntimeConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRole(role: unknown): string {
  return canonicalizeAgentRole(typeof role === "string" ? role : "");
}

export function roleRequiresQaCoverage(role: unknown): boolean {
  return TECH_ROLES_REQUIRING_QA.has(normalizeRole(role));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const STRIPPED_SEED_ADAPTER_CONFIG_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "paperclipRuntimeSkills",
] as const;

function stripSeedAdapterConfig(adapterConfig: unknown): RuntimeConfigRecord {
  const next = isRecord(adapterConfig) ? { ...adapterConfig } : {};
  for (const key of STRIPPED_SEED_ADAPTER_CONFIG_KEYS) {
    delete next[key];
  }
  return next;
}

export function stripCooSeedAdapterConfig(adapterConfig: unknown): RuntimeConfigRecord {
  return stripSeedAdapterConfig(adapterConfig);
}

const COO_DESIGNATION_PATTERNS = [
  /\bcoo\b/,
  /chief\s+operating\s+officer/,
  /head\s+of\s+operations/,
  /operations\s+lead/,
];

function isCooDesignation(input: { name?: unknown; title?: unknown }): boolean {
  const combined = `${normalizeText(input.name)}\n${normalizeText(input.title)}`;
  if (!combined.trim()) return false;
  return COO_DESIGNATION_PATTERNS.some((pattern) => pattern.test(combined));
}

export function resolveRoleForCooCoordinatorModel(input: {
  role: unknown;
  name?: unknown;
  title?: unknown;
}): string {
  const canonicalRole = normalizeRole(input.role);
  if (canonicalRole === "coo") return canonicalRole;
  if (isCooDesignation(input)) return "coo";
  return canonicalRole;
}

function cloneRuntimeConfig(runtimeConfig: unknown): RuntimeConfigRecord {
  return isRecord(runtimeConfig)
    ? (structuredClone(runtimeConfig) as RuntimeConfigRecord)
    : {};
}

export function normalizeRuntimeConfigForCooHeartbeatModel(input: {
  role: unknown;
  name?: unknown;
  title?: unknown;
  runtimeConfig: unknown;
  mode?: HeartbeatModelMode;
}): RuntimeConfigRecord {
  const mode = input.mode ?? "default";
  const normalizedRole = resolveRoleForCooCoordinatorModel({
    role: input.role,
    name: input.name,
    title: input.title,
  });
  const isCooCoordinator = normalizedRole === "coo";

  const next = cloneRuntimeConfig(input.runtimeConfig);
  const heartbeat = isRecord(next.heartbeat) ? { ...next.heartbeat } : {};

  const hasExplicitEnabled = typeof heartbeat.enabled === "boolean";
  if (mode === "enforce" || !hasExplicitEnabled) {
    heartbeat.enabled = isCooCoordinator;
  }

  if (isCooCoordinator) {
    const intervalSec = asFiniteNumber(heartbeat.intervalSec);
    if (mode === "enforce") {
      heartbeat.intervalSec = intervalSec !== null && intervalSec > 0
        ? intervalSec
        : COO_COORDINATOR_DEFAULT_INTERVAL_SEC;
    } else if (intervalSec === null) {
      heartbeat.intervalSec = COO_COORDINATOR_DEFAULT_INTERVAL_SEC;
    }
  }

  next.heartbeat = heartbeat;
  return next;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function agentHeartbeatModelService(db: Db) {
  const agentsSvc = agentService(db);
  const instructions = agentInstructionsService();
  const ACTIVE_AGENT_SELECTION = {
    id: agents.id,
    companyId: agents.companyId,
    name: agents.name,
    title: agents.title,
    role: agents.role,
    status: agents.status,
    reportsTo: agents.reportsTo,
    adapterType: agents.adapterType,
    adapterConfig: agents.adapterConfig,
    pauseReason: agents.pauseReason,
    pausedAt: agents.pausedAt,
  } as const;

  type ActiveAgentRow = {
    id: string;
    companyId: string;
    name: string;
    title: string | null;
    role: string;
    status: string;
    reportsTo: string | null;
    adapterType: string;
    adapterConfig: unknown;
    pauseReason: string | null;
    pausedAt: Date | null;
  };

  async function listActiveCompanyAgents(companyId: string): Promise<ActiveAgentRow[]> {
    return db
      .select(ACTIVE_AGENT_SELECTION)
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          ne(agents.status, "terminated"),
          ne(agents.status, "pending_approval"),
        ),
      );
  }

  async function ensureCompanyHasCooCoordinator(
    companyId: string,
    apply: boolean,
  ): Promise<CompanyCooCoverageResult> {
    const company = await db
      .select({
        id: companies.id,
        name: companies.name,
      })
      .from(companies)
      .where(and(eq(companies.id, companyId), ne(companies.status, "archived")))
      .then((rows) => rows[0] ?? null);

    if (!company) {
      return {
        apply,
        companyId,
        companyName: null,
        created: false,
        reason: "company_not_found",
        createdAgentId: null,
      };
    }

    const rows = await listActiveCompanyAgents(companyId);

    const hasCoordinator = rows.some((row) => resolveRoleForCooCoordinatorModel({
      role: row.role,
      name: row.name,
      title: row.title,
    }) === "coo");
    if (hasCoordinator) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: false,
        reason: "already_has_coo",
        createdAgentId: null,
      };
    }

    const ceo = rows.find((row) => normalizeRole(row.role) === "ceo") ?? null;
    if (!ceo) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: false,
        reason: "no_ceo",
        createdAgentId: null,
      };
    }

    const cooName = deduplicateAgentName(
      COO_COORDINATOR_DEFAULT_NAME,
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
      })),
    );
    const normalizedRole = resolveRoleForCooCoordinatorModel({
      role: "coo",
      name: cooName,
      title: COO_COORDINATOR_DEFAULT_TITLE,
    });
    const normalizedRuntimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
      role: normalizedRole,
      name: cooName,
      title: COO_COORDINATOR_DEFAULT_TITLE,
      runtimeConfig: {},
      mode: "enforce",
    });

    if (!apply) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: true,
        reason: "coo_created",
        createdAgentId: null,
      };
    }

    const seedStatus = ceo.status === "paused" ? "paused" : "idle";
    const created = await agentsSvc.create(companyId, {
      name: cooName,
      role: normalizedRole,
      title: COO_COORDINATOR_DEFAULT_TITLE,
      reportsTo: ceo.id,
      icon: null,
      capabilities: null,
      adapterType: ceo.adapterType,
      adapterConfig: stripCooSeedAdapterConfig(ceo.adapterConfig),
      runtimeConfig: normalizedRuntimeConfig,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      status: seedStatus,
      pauseReason: seedStatus === "paused" ? (ceo.pauseReason ?? "manual") : null,
      pausedAt: seedStatus === "paused" ? (ceo.pausedAt ?? new Date()) : null,
      permissions: undefined,
      lastHeartbeatAt: null,
      metadata: null,
    });

    const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
    const materialized = await instructions.materializeManagedBundle(created, cooBundle, {
      entryFile: "AGENTS.md",
      replaceExisting: false,
      clearLegacyPromptTemplate: true,
    });
    await agentsSvc.update(created.id, { adapterConfig: materialized.adapterConfig });

    return {
      apply,
      companyId,
      companyName: company.name,
      created: true,
      reason: "coo_created",
      createdAgentId: created.id,
    };
  }

  function pickQaSeedAgent(rows: ActiveAgentRow[]): ActiveAgentRow | null {
    const byRole = (role: string) => rows.find((row) => normalizeRole(row.role) === role) ?? null;
    return byRole("cto")
      ?? byRole("engineer")
      ?? byRole("devops")
      ?? byRole("ceo")
      ?? byRole("coo")
      ?? rows[0]
      ?? null;
  }

  function pickQaManagerId(rows: ActiveAgentRow[], seedAgent: ActiveAgentRow): string | null {
    const byRole = (role: string) => rows.find((row) => normalizeRole(row.role) === role)?.id ?? null;
    const preferredManagerId = byRole("coo") ?? byRole("ceo") ?? byRole("cto");
    if (preferredManagerId) return preferredManagerId;

    if (seedAgent.reportsTo && rows.some((row) => row.id === seedAgent.reportsTo)) {
      return seedAgent.reportsTo;
    }

    return null;
  }

  async function ensureCompanyHasQaReleaseEngineer(
    companyId: string,
    apply: boolean,
  ): Promise<CompanyQaCoverageResult> {
    const company = await db
      .select({
        id: companies.id,
        name: companies.name,
      })
      .from(companies)
      .where(and(eq(companies.id, companyId), ne(companies.status, "archived")))
      .then((rows) => rows[0] ?? null);

    if (!company) {
      return {
        apply,
        companyId,
        companyName: null,
        created: false,
        reason: "company_not_found",
        createdAgentId: null,
      };
    }

    const rows = await listActiveCompanyAgents(companyId);
    const hasTechTeam = rows.some((row) => roleRequiresQaCoverage(row.role));
    if (!hasTechTeam) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: false,
        reason: "no_tech_team",
        createdAgentId: null,
      };
    }

    const hasQa = rows.some((row) => normalizeRole(row.role) === "qa");
    if (hasQa) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: false,
        reason: "already_has_qa",
        createdAgentId: null,
      };
    }

    const seedAgent = pickQaSeedAgent(rows);
    if (!seedAgent) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: false,
        reason: "no_tech_team",
        createdAgentId: null,
      };
    }

    const qaName = deduplicateAgentName(
      QA_RELEASE_DEFAULT_NAME,
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
      })),
    );
    const reportsTo = pickQaManagerId(rows, seedAgent);

    if (!apply) {
      return {
        apply,
        companyId,
        companyName: company.name,
        created: true,
        reason: "qa_created",
        createdAgentId: null,
      };
    }

    const seedStatus = seedAgent.status === "paused" ? "paused" : "idle";
    const created = await agentsSvc.create(companyId, {
      name: qaName,
      role: "qa",
      title: QA_RELEASE_DEFAULT_TITLE,
      reportsTo,
      icon: null,
      capabilities: null,
      adapterType: seedAgent.adapterType,
      adapterConfig: stripSeedAdapterConfig(seedAgent.adapterConfig),
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      status: seedStatus,
      pauseReason: seedStatus === "paused" ? (seedAgent.pauseReason ?? "manual") : null,
      pausedAt: seedStatus === "paused" ? (seedAgent.pausedAt ?? new Date()) : null,
      permissions: undefined,
      lastHeartbeatAt: null,
      metadata: null,
    });

    const qaBundle = await loadDefaultAgentInstructionsBundle("qa");
    const materialized = await instructions.materializeManagedBundle(created, qaBundle, {
      entryFile: "AGENTS.md",
      replaceExisting: false,
      clearLegacyPromptTemplate: true,
    });
    await agentsSvc.update(created.id, { adapterConfig: materialized.adapterConfig });

    return {
      apply,
      companyId,
      companyName: company.name,
      created: true,
      reason: "qa_created",
      createdAgentId: created.id,
    };
  }

  return {
    async alignCooCoordinatorHeartbeats(options?: { apply?: boolean }): Promise<HeartbeatModelReport> {
      const apply = options?.apply === true;
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          title: agents.title,
          role: agents.role,
          runtimeConfig: agents.runtimeConfig,
        })
        .from(agents)
        .where(and(ne(agents.status, "terminated"), ne(agents.status, "pending_approval")));

      const touchedCompanyIds = new Set<string>();
      let updatedAgents = 0;
      let unchangedAgents = 0;

      for (const row of rows) {
        const normalizedRole = resolveRoleForCooCoordinatorModel({
          role: row.role,
          name: row.name,
          title: row.title,
        });
        const normalizedRuntimeConfig = normalizeRuntimeConfigForCooHeartbeatModel({
          role: normalizedRole,
          name: row.name,
          title: row.title,
          runtimeConfig: row.runtimeConfig,
          mode: "enforce",
        });
        const roleNeedsUpdate = row.role !== normalizedRole;

        if (jsonEqual(normalizedRuntimeConfig, row.runtimeConfig) && !roleNeedsUpdate) {
          unchangedAgents += 1;
          continue;
        }

        updatedAgents += 1;
        touchedCompanyIds.add(row.companyId);

        if (!apply) continue;

        await db
          .update(agents)
          .set({
            role: normalizedRole,
            runtimeConfig: normalizedRuntimeConfig,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, row.id));
      }

      return {
        apply,
        scannedAgents: rows.length,
        updatedAgents,
        unchangedAgents,
        touchedCompanyIds: Array.from(touchedCompanyIds),
      };
    },

    async ensureCompanyHasCooCoordinator(companyId: string, options?: { apply?: boolean }) {
      const apply = options?.apply === true;
      return ensureCompanyHasCooCoordinator(companyId, apply);
    },

    async backfillMissingCooCoordinators(options?: { apply?: boolean }): Promise<CooCoordinatorCoverageReport> {
      const apply = options?.apply === true;
      const companyRows = await db
        .select({
          id: companies.id,
        })
        .from(companies)
        .where(ne(companies.status, "archived"));

      const createdCompanyIds = new Set<string>();
      let companiesWithCoordinator = 0;
      let companiesMissingCoordinator = 0;
      let companiesSkippedNoCeo = 0;
      let createdAgents = 0;

      for (const company of companyRows) {
        const result = await ensureCompanyHasCooCoordinator(company.id, apply);
        if (result.reason === "already_has_coo") {
          companiesWithCoordinator += 1;
          continue;
        }
        if (result.reason === "no_ceo") {
          companiesMissingCoordinator += 1;
          companiesSkippedNoCeo += 1;
          continue;
        }
        if (result.reason === "coo_created") {
          companiesMissingCoordinator += 1;
          createdAgents += 1;
          createdCompanyIds.add(result.companyId);
        }
      }

      return {
        apply,
        scannedCompanies: companyRows.length,
        companiesWithCoordinator,
        companiesMissingCoordinator,
        companiesSkippedNoCeo,
        createdAgents,
        createdCompanyIds: Array.from(createdCompanyIds),
      };
    },

    async ensureCompanyHasQaReleaseEngineer(companyId: string, options?: { apply?: boolean }) {
      const apply = options?.apply === true;
      return ensureCompanyHasQaReleaseEngineer(companyId, apply);
    },

    async backfillMissingQaReleaseEngineers(options?: { apply?: boolean }): Promise<QaReleaseCoverageReport> {
      const apply = options?.apply === true;
      const companyRows = await db
        .select({
          id: companies.id,
        })
        .from(companies)
        .where(ne(companies.status, "archived"));

      const createdCompanyIds = new Set<string>();
      let companiesWithQa = 0;
      let companiesWithTechTeam = 0;
      let companiesMissingQa = 0;
      let companiesSkippedNoTechTeam = 0;
      let createdAgents = 0;

      for (const company of companyRows) {
        const result = await ensureCompanyHasQaReleaseEngineer(company.id, apply);
        if (result.reason === "no_tech_team") {
          companiesSkippedNoTechTeam += 1;
          continue;
        }

        companiesWithTechTeam += 1;
        if (result.reason === "already_has_qa") {
          companiesWithQa += 1;
          continue;
        }

        if (result.reason === "qa_created") {
          companiesMissingQa += 1;
          createdAgents += 1;
          createdCompanyIds.add(result.companyId);
        }
      }

      return {
        apply,
        scannedCompanies: companyRows.length,
        companiesWithQa,
        companiesWithTechTeam,
        companiesMissingQa,
        companiesSkippedNoTechTeam,
        createdAgents,
        createdCompanyIds: Array.from(createdCompanyIds),
      };
    },

    async syncCooCoordinatorInstructions(options?: { apply?: boolean }): Promise<CooInstructionsSyncReport> {
      const apply = options?.apply === true;
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          title: agents.title,
          role: agents.role,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(and(ne(agents.status, "terminated"), ne(agents.status, "pending_approval")));

      const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
      const expectedAgentsMd = cooBundle["AGENTS.md"] ?? "";
      const touchedCompanyIds = new Set<string>();
      const updatedAgentIds = new Set<string>();
      let scannedCooAgents = 0;
      let updatedAgents = 0;
      let unchangedAgents = 0;
      let skippedExternalBundles = 0;

      for (const row of rows) {
        const normalizedRole = resolveRoleForCooCoordinatorModel({
          role: row.role,
          name: row.name,
          title: row.title,
        });
        if (normalizedRole !== "coo") continue;

        scannedCooAgents += 1;
        const bundle = await instructions.getBundle(row);
        if (bundle.mode === "external") {
          skippedExternalBundles += 1;
          unchangedAgents += 1;
          continue;
        }

        const hasAgentsFile = bundle.files.some((file) => file.path === "AGENTS.md");
        let currentAgentsMd: string | null = null;
        if (hasAgentsFile) {
          try {
            currentAgentsMd = (await instructions.readFile(row, "AGENTS.md")).content;
          } catch {
            currentAgentsMd = null;
          }
        }

        const needsSync = bundle.mode !== "managed"
          || bundle.entryFile !== "AGENTS.md"
          || !hasAgentsFile
          || currentAgentsMd !== expectedAgentsMd;

        if (!needsSync) {
          unchangedAgents += 1;
          continue;
        }

        updatedAgents += 1;
        touchedCompanyIds.add(row.companyId);
        updatedAgentIds.add(row.id);
        if (!apply) continue;

        const materialized = await instructions.materializeManagedBundle(row, cooBundle, {
          entryFile: "AGENTS.md",
          replaceExisting: true,
          clearLegacyPromptTemplate: true,
        });
        await agentsSvc.update(row.id, { adapterConfig: materialized.adapterConfig });
      }

      return {
        apply,
        scannedCooAgents,
        updatedAgents,
        unchangedAgents,
        skippedExternalBundles,
        touchedCompanyIds: Array.from(touchedCompanyIds),
        updatedAgentIds: Array.from(updatedAgentIds),
      };
    },

    async syncQaReleaseEngineerInstructions(options?: { apply?: boolean }): Promise<QaInstructionsSyncReport> {
      const apply = options?.apply === true;
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          title: agents.title,
          role: agents.role,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(and(ne(agents.status, "terminated"), ne(agents.status, "pending_approval")));

      const touchedCompanyIds = new Set<string>();
      const updatedAgentIds = new Set<string>();
      let scannedQaAgents = 0;
      let updatedAgents = 0;
      let unchangedAgents = 0;
      let skippedExternalBundles = 0;

      for (const row of rows) {
        if (normalizeRole(row.role) !== "qa") continue;

        scannedQaAgents += 1;
        const bundle = await instructions.getBundle(row);
        if (bundle.mode === "external") {
          skippedExternalBundles += 1;
          unchangedAgents += 1;
          continue;
        }

        const hasEntryFile = bundle.files.some((file) => file.path === bundle.entryFile);
        let currentEntryContent: string | null = null;
        if (hasEntryFile) {
          try {
            currentEntryContent = (await instructions.readFile(row, bundle.entryFile)).content;
          } catch {
            currentEntryContent = null;
          }
        }

        const exported = await instructions.exportFiles(row);
        const expectedEntryContent = exported.files[bundle.entryFile] ?? "";
        const needsSync = bundle.mode !== "managed"
          || !hasEntryFile
          || currentEntryContent !== expectedEntryContent;

        if (!needsSync) {
          unchangedAgents += 1;
          continue;
        }

        updatedAgents += 1;
        touchedCompanyIds.add(row.companyId);
        updatedAgentIds.add(row.id);
        if (!apply) continue;

        const materialized = await instructions.materializeManagedBundle(row, exported.files, {
          entryFile: exported.entryFile,
          replaceExisting: true,
          clearLegacyPromptTemplate: true,
        });
        await agentsSvc.update(row.id, { adapterConfig: materialized.adapterConfig });
      }

      return {
        apply,
        scannedQaAgents,
        updatedAgents,
        unchangedAgents,
        skippedExternalBundles,
        touchedCompanyIds: Array.from(touchedCompanyIds),
        updatedAgentIds: Array.from(updatedAgentIds),
      };
    },
  };
}
