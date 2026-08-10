import { Command } from "commander";
import type {
  Approval,
  CatalogTeam,
  CatalogTeamImportPreviewResult,
  CatalogTeamInstallResult,
  CatalogTeamInstallOptions,
  CatalogTeamImportOptions,
  CatalogTeamSourcePolicy,
  InstalledCatalogTeam,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";
import { ApiRequestError } from "../../client/http.js";

interface TeamBrowseOptions extends BaseClientOptions {
  kind?: string;
  category?: string;
  query?: string;
}

interface TeamListOptions extends TeamBrowseOptions {}

interface TeamPreviewOptions extends BaseClientOptions {
  companyId?: string;
  targetManagerAgentId?: string;
  targetManagerSlug?: string;
  agent?: string[];
  collisionStrategy?: "rename" | "skip" | "replace";
  nameOverride?: string[];
  selectedFile?: string[];
  allowExternalSources?: boolean;
  allowUnpinnedOptionalSources?: boolean;
  allowLocalPathSources?: boolean;
}

interface TeamInstallOptions extends TeamPreviewOptions {
  requestApprovalOnForbidden?: boolean;
  approvalIssueId?: string;
  secretValue?: string[];
  adapterOverride?: string[];
}

interface TeamInstallApprovalFallbackResult {
  status: "approval_requested";
  approval: Approval;
  installAttempt: {
    companyId: string;
    catalogRef: string;
    options: CatalogTeamInstallOptions;
    deniedReason: string;
  };
}

export function registerTeamCommands(program: Command): void {
  const teams = program.command("teams").description("App-shipped team catalog operations");

  addCommonClientOptions(
    teams
      .command("browse")
      .description("Browse app-shipped catalog teams without installing them")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .option("--query <text>", "Search catalog text")
      .action(async (opts: TeamBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogTeams(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogTeamRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teams
      .command("list")
      .description("List app-shipped catalog teams with installed status for a company")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .option("--query <text>", "Search catalog text")
      .action(async (opts: TeamListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listCatalogTeamStatusRows(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogTeamStatusRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    teams
      .command("search")
      .description("Search app-shipped catalog teams without installing them")
      .argument("<query>", "Search text")
      .option("--kind <kind>", "Catalog kind filter (bundled or optional)")
      .option("--category <slug>", "Catalog category filter")
      .action(async (query: string, opts: TeamBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogTeams(ctx, { ...opts, query });
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogTeamRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teams
      .command("inspect")
      .description("Inspect an app-shipped catalog team before installing it")
      .argument("<catalogRef>", "Catalog team ID, key, or unique slug")
      .option("--file <path>", "Print a specific catalog team file instead of the manifest detail")
      .action(async (catalogRef: string, opts: BaseClientOptions & { file?: string }) => {
        try {
          const ctx = resolveCommandContext(opts);
          if (opts.file?.trim()) {
            const file = await getCatalogTeamFile(ctx, catalogRef, opts.file);
            if (ctx.json) {
              printOutput(file, { json: true });
              return;
            }
            process.stdout.write(file?.content ?? "");
            if (file?.content && !file.content.endsWith("\n")) {
              process.stdout.write("\n");
            }
            return;
          }

          const detail = await getCatalogTeam(ctx, catalogRef);
          if (ctx.json) {
            printOutput(detail, { json: true });
            return;
          }
          printCatalogTeamDetail(detail);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teams
      .command("preview")
      .description("Preview importing a catalog team into a company")
      .argument("<catalogRef>", "Catalog team ID, key, or unique slug")
      .option("--target-manager-agent-id <id>", "Existing agent ID that catalog root agents should report to")
      .option("--target-manager-slug <slug>", "Portable manager slug that catalog root agents should report to")
      .option("--agent <slug>", "Only preview selected agent slug; may be repeated", collectOptionValue, [] as string[])
      .option("--collision-strategy <strategy>", "Import collision strategy (rename, skip, replace)")
      .option("--name-override <slug=name>", "Override an imported entity name; may be repeated", collectOptionValue, [] as string[])
      .option("--selected-file <path>", "Restrict import preview to selected portable file; may be repeated", collectOptionValue, [] as string[])
      .option("--allow-external-sources", "Allow GitHub, URL, or skills.sh skill sources declared by the catalog team", false)
      .option("--allow-unpinned-optional-sources", "Allow optional-team external skill sources that are not pinned to a commit", false)
      .option("--allow-local-path-sources", "Development only: allow local-path skill sources declared by the catalog team", false)
      .action(async (catalogRef: string, opts: TeamPreviewOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CatalogTeamImportPreviewResult>(
            catalogTeamCompanyPath(ctx.companyId, catalogRef, "preview"),
            buildTeamOptions(opts),
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogTeamPreview(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    teams
      .command("install")
      .description("Install a catalog team into a company")
      .argument("<catalogRef>", "Catalog team ID, key, or unique slug")
      .option("--target-manager-agent-id <id>", "Existing agent ID that catalog root agents should report to")
      .option("--target-manager-slug <slug>", "Portable manager slug that catalog root agents should report to")
      .option("--agent <slug>", "Only install selected agent slug; may be repeated", collectOptionValue, [] as string[])
      .option("--collision-strategy <strategy>", "Import collision strategy (rename, skip, replace)")
      .option("--name-override <slug=name>", "Override an imported entity name; may be repeated", collectOptionValue, [] as string[])
      .option("--selected-file <path>", "Restrict install to selected portable file; may be repeated", collectOptionValue, [] as string[])
      .option("--secret-value <key=value>", "Secret env input value for install; may be repeated", collectOptionValue, [] as string[])
      .option("--adapter-override <slug=type>", "Adapter type override for an imported agent slug; may be repeated", collectOptionValue, [] as string[])
      .option("--allow-external-sources", "Allow GitHub, URL, or skills.sh skill sources declared by the catalog team", false)
      .option("--allow-unpinned-optional-sources", "Allow optional-team external skill sources that are not pinned to a commit", false)
      .option("--allow-local-path-sources", "Development only: allow local-path skill sources declared by the catalog team", false)
      .option(
        "--request-approval-on-forbidden",
        "When install is denied by agents:create permissions, create a board approval request instead of exiting with the raw 403",
        false,
      )
      .option("--approval-issue-id <id>", "Issue ID to link to the fallback approval request; defaults to PAPERCLIP_TASK_ID when set")
      .action(async (catalogRef: string, opts: TeamInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const installOptions = buildTeamInstallOptions(opts);
          const result = await ctx.api.post<CatalogTeamInstallResult>(
            catalogTeamCompanyPath(ctx.companyId, catalogRef, "install"),
            installOptions,
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogTeamInstall(result);
        } catch (err) {
          if (shouldRequestInstallApproval(err, opts)) {
            try {
              const ctx = resolveCommandContext(opts, { requireCompany: true });
              const fallback = await requestInstallApproval(ctx, catalogRef, buildTeamInstallOptions(opts), opts, err);
              if (ctx.json) {
                printOutput(fallback, { json: true });
                return;
              }
              printInstallApprovalRequested(fallback);
              return;
            } catch (fallbackErr) {
              handleCommandError(fallbackErr);
            }
          }
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function listCatalogTeams(
  ctx: ResolvedClientContext,
  opts: TeamBrowseOptions,
): Promise<CatalogTeam[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, "kind", opts.kind);
  appendQueryParam(params, "category", opts.category);
  appendQueryParam(params, "q", opts.query);
  const query = params.toString();
  return (await ctx.api.get<CatalogTeam[]>(`/api/teams/catalog${query ? `?${query}` : ""}`)) ?? [];
}

type CatalogTeamInstalledStatus = "not_installed" | "installed" | "out_of_date" | "installed_missing";

interface CatalogTeamStatusRow {
  catalogId: string;
  catalogKey: string | null;
  kind: CatalogTeam["kind"] | null;
  category: string | null;
  slug: string | null;
  name: string;
  installedStatus: CatalogTeamInstalledStatus;
  installedAgentCount: number;
  catalogAgentCount: number | null;
  projectCount: number | null;
  trustLevel: CatalogTeam["trustLevel"] | null;
  present: boolean;
  outOfDate: boolean;
  currentContentHash: string | null;
  installedOriginHashes: string[];
}

async function listCatalogTeamStatusRows(
  ctx: ResolvedClientContext,
  opts: TeamListOptions,
): Promise<CatalogTeamStatusRow[]> {
  if (!ctx.companyId) {
    throw new Error("Company ID is required.");
  }

  const [teams, installed] = await Promise.all([
    listCatalogTeams(ctx, opts),
    ctx.api.get<InstalledCatalogTeam[]>(
      `/api/companies/${encodeURIComponent(ctx.companyId)}/teams/catalog/installed`,
    ),
  ]);

  const installedByCatalogId = new Map((installed ?? []).map((row) => [row.catalogId, row]));
  const rows = teams.map((team) => {
    const installedTeam = installedByCatalogId.get(team.id);
    if (installedTeam) {
      installedByCatalogId.delete(team.id);
    }
    return buildCatalogTeamStatusRow(team, installedTeam ?? null);
  });

  for (const installedTeam of installedByCatalogId.values()) {
    if (installedTeam.present) continue;
    rows.push(buildMissingInstalledTeamStatusRow(installedTeam));
  }

  return rows;
}

async function getCatalogTeam(ctx: ResolvedClientContext, catalogRef: string): Promise<CatalogTeam> {
  const ref = catalogRef.trim();
  if (!ref) {
    throw new Error("Catalog team reference is required.");
  }
  const detail = await ctx.api.get<CatalogTeam>(`/api/teams/catalog/ref?ref=${encodeURIComponent(ref)}`);
  if (!detail) {
    throw new Error(`Catalog team not found: ${catalogRef}`);
  }
  return detail;
}

async function getCatalogTeamFile(
  ctx: ResolvedClientContext,
  catalogRef: string,
  filePath: string,
): Promise<{ content: string } | null> {
  const ref = catalogRef.trim();
  const path = filePath.trim();
  if (!ref) throw new Error("Catalog team reference is required.");
  if (!path) throw new Error("Catalog team file path is required.");
  const params = new URLSearchParams({ ref, path });
  return ctx.api.get(`/api/teams/catalog/ref/files?${params.toString()}`);
}

function catalogTeamCompanyPath(companyId: string | undefined, catalogRef: string, action: "preview" | "install") {
  if (!companyId) throw new Error("Company ID is required.");
  const params = new URLSearchParams({ ref: catalogRef.trim() });
  return `/api/companies/${encodeURIComponent(companyId)}/teams/catalog/ref/${action}?${params.toString()}`;
}

function buildTeamOptions(opts: TeamPreviewOptions): CatalogTeamImportOptions {
  return removeUndefined({
    targetManagerAgentId: emptyStringToUndefined(opts.targetManagerAgentId),
    targetManagerSlug: emptyStringToUndefined(opts.targetManagerSlug),
    agents: opts.agent && opts.agent.length > 0 ? opts.agent : undefined,
    collisionStrategy: opts.collisionStrategy,
    nameOverrides: parseNameOverrides(opts.nameOverride),
    selectedFiles: opts.selectedFile && opts.selectedFile.length > 0 ? opts.selectedFile : undefined,
    sourcePolicy: buildSourcePolicy(opts),
  });
}

function buildTeamInstallOptions(opts: TeamInstallOptions): CatalogTeamInstallOptions {
  return removeUndefined({
    ...buildTeamOptions(opts),
    adapterOverrides: parseAdapterOverrides(opts.adapterOverride),
    secretValues: parseSecretValues(opts.secretValue),
  });
}

const INSTALL_APPROVAL_FALLBACK_MESSAGES = [
  "missing permission: agents:create",
  "missing permission: can create agents",
];
const SECRET_VALUE_REDACTION = "[redacted]";

function shouldRequestInstallApproval(error: unknown, opts: TeamInstallOptions): error is ApiRequestError {
  if (!(opts.requestApprovalOnForbidden || isPaperclipTaskRun())) return false;
  if (!(error instanceof ApiRequestError) || error.status !== 403) return false;
  const message = error.message.toLowerCase();
  return INSTALL_APPROVAL_FALLBACK_MESSAGES.some((expected) => message.includes(expected));
}

function isPaperclipTaskRun(): boolean {
  return Boolean(process.env.PAPERCLIP_TASK_ID?.trim());
}

async function requestInstallApproval(
  ctx: ResolvedClientContext,
  catalogRef: string,
  installOptions: CatalogTeamInstallOptions,
  opts: TeamInstallOptions,
  error: ApiRequestError,
): Promise<TeamInstallApprovalFallbackResult> {
  if (!ctx.companyId) throw new Error("Company ID is required.");
  const trimmedRef = catalogRef.trim();
  const issueIds = resolveApprovalIssueIds(opts);
  const approvalInstallOptions = omitInstallSecretValues(installOptions);
  const returnedInstallOptions = redactInstallSecretValues(installOptions);
  const payload = {
    type: "request_board_approval",
    issueIds,
    payload: {
      title: `Approve catalog team install: ${trimmedRef}`,
      summary:
        `A Paperclip CLI agent-run attempted to install catalog team "${trimmedRef}" into company "${ctx.companyId}", ` +
        `but the API denied the install with: ${error.message}.`,
      recommendedAction:
        "Approve the catalog team source and rerun the install with a board or agent-creator token, or grant agents:create to the requesting agent and rerun the same command.",
      risks: [
        "Catalog team installation can create agents, projects, tasks, routines, skills, and secret bindings.",
        "Only approve after checking the catalog source, selected files, target manager, and collision strategy.",
      ],
      installAttempt: {
        companyId: ctx.companyId,
        catalogRef: trimmedRef,
        options: approvalInstallOptions,
        deniedReason: error.message,
      },
    },
  };
  const approval = await ctx.api.post<Approval>(apiPath`/api/companies/${ctx.companyId}/approvals`, payload);
  if (!approval) {
    throw new Error("Approval request failed.");
  }
  return {
    status: "approval_requested",
    approval,
    installAttempt: {
      companyId: ctx.companyId,
      catalogRef: trimmedRef,
      options: returnedInstallOptions,
      deniedReason: error.message,
    },
  };
}

function omitInstallSecretValues(options: CatalogTeamInstallOptions): CatalogTeamInstallOptions {
  if (!options.secretValues) return options;
  const { secretValues: _secretValues, ...safeOptions } = options;
  return safeOptions;
}

function redactInstallSecretValues(options: CatalogTeamInstallOptions): CatalogTeamInstallOptions {
  if (!options.secretValues) return options;
  return {
    ...options,
    secretValues: Object.fromEntries(
      Object.keys(options.secretValues).map((key) => [key, SECRET_VALUE_REDACTION]),
    ),
  };
}

function resolveApprovalIssueIds(opts: TeamInstallOptions): string[] | undefined {
  const issueId = opts.approvalIssueId?.trim() || process.env.PAPERCLIP_TASK_ID?.trim();
  if (!issueId) return undefined;
  return isUuidLike(issueId) ? [issueId] : undefined;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildSourcePolicy(opts: TeamPreviewOptions): CatalogTeamSourcePolicy | undefined {
  const sourcePolicy = removeUndefined({
    allowExternalSources: opts.allowExternalSources || undefined,
    allowUnpinnedOptionalSources: opts.allowUnpinnedOptionalSources || undefined,
    allowLocalPathSources: opts.allowLocalPathSources || undefined,
  });
  return Object.keys(sourcePolicy).length > 0 ? sourcePolicy : undefined;
}

function parseNameOverrides(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const raw of values) {
    const [slug, name] = parseKeyValueOption(raw, "--name-override", "slug=name");
    if (!slug || !name) {
      throw new Error(`Invalid --name-override "${raw}". Use slug=name.`);
    }
    result[slug] = name;
  }
  return result;
}

function parseSecretValues(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const raw of values) {
    const [key, value] = parseKeyValueOption(raw, "--secret-value", "key=value");
    if (!key) {
      throw new Error(`Invalid --secret-value "${raw}". Use key=value.`);
    }
    result[key] = value;
  }
  return result;
}

function parseAdapterOverrides(
  values: string[] | undefined,
): CatalogTeamInstallOptions["adapterOverrides"] | undefined {
  if (!values || values.length === 0) return undefined;
  const result: NonNullable<CatalogTeamInstallOptions["adapterOverrides"]> = {};
  for (const raw of values) {
    const [slug, adapterType] = parseKeyValueOption(raw, "--adapter-override", "slug=type");
    if (!slug || !adapterType) {
      throw new Error(`Invalid --adapter-override "${raw}". Use slug=type.`);
    }
    result[slug] = { adapterType };
  }
  return result;
}

function parseKeyValueOption(raw: string, flag: string, format: string): [string, string] {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid ${flag} "${raw}". Use ${format}.`);
  }
  return [raw.slice(0, separator).trim(), raw.slice(separator + 1).trim()];
}

function removeUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function emptyStringToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function appendQueryParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
}

function printCatalogTeamRows(rows: CatalogTeam[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  printTable(rows.map((row) => ({
    id: row.id,
    key: row.key,
    kind: row.kind,
    category: row.category,
    slug: row.slug,
    name: row.name,
    trust: row.trustLevel,
    agents: row.counts.agents,
    projects: row.counts.projects,
  })));
}

function buildCatalogTeamStatusRow(
  team: CatalogTeam,
  installed: InstalledCatalogTeam | null,
): CatalogTeamStatusRow {
  return {
    catalogId: team.id,
    catalogKey: team.key,
    kind: team.kind,
    category: team.category,
    slug: team.slug,
    name: team.name,
    installedStatus: installed ? (installed.outOfDate ? "out_of_date" : "installed") : "not_installed",
    installedAgentCount: installed?.agentCount ?? 0,
    catalogAgentCount: team.counts.agents,
    projectCount: team.counts.projects,
    trustLevel: team.trustLevel,
    present: true,
    outOfDate: installed?.outOfDate ?? false,
    currentContentHash: team.contentHash,
    installedOriginHashes: installed?.installedOriginHashes ?? [],
  };
}

function buildMissingInstalledTeamStatusRow(installed: InstalledCatalogTeam): CatalogTeamStatusRow {
  const name = installed.catalogKey ?? installed.catalogId;
  return {
    catalogId: installed.catalogId,
    catalogKey: installed.catalogKey,
    kind: null,
    category: null,
    slug: null,
    name,
    installedStatus: "installed_missing",
    installedAgentCount: installed.agentCount,
    catalogAgentCount: null,
    projectCount: null,
    trustLevel: null,
    present: false,
    outOfDate: false,
    currentContentHash: installed.currentContentHash,
    installedOriginHashes: installed.installedOriginHashes,
  };
}

function printCatalogTeamStatusRows(rows: CatalogTeamStatusRow[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  printTable(rows.map((row) => ({
    id: row.catalogId,
    key: row.catalogKey,
    kind: row.kind,
    category: row.category,
    slug: row.slug,
    name: row.name,
    installedStatus: row.installedStatus,
    installedAgents: row.installedAgentCount,
    catalogAgents: row.catalogAgentCount,
    projects: row.projectCount,
    trust: row.trustLevel,
  })));
}

function printCatalogTeamDetail(team: CatalogTeam): void {
  console.log(
    formatInlineRecord({
      id: team.id,
      key: team.key,
      kind: team.kind,
      category: team.category,
      slug: team.slug,
      name: team.name,
      trust: team.trustLevel,
      compatibility: team.compatibility,
      contentHash: team.contentHash,
    }),
  );
  console.log(`description=${team.description || "-"}`);
  console.log(`recommendedForCompanyTypes=${team.recommendedForCompanyTypes.join(",") || "-"}`);
  console.log(`tags=${team.tags.join(",") || "-"}`);
  console.log(
    `counts=agents:${team.counts.agents},projects:${team.counts.projects},tasks:${team.counts.tasks},skills:${team.counts.localSkills + team.counts.catalogSkills}`,
  );
  console.log("files:");
  printTable(team.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  })));
}

function printCatalogTeamPreview(result: CatalogTeamImportPreviewResult | null): void {
  if (!result) {
    console.log("Catalog team preview returned no result.");
    return;
  }
  const preview = result.portabilityPreview;
  console.log(
    `Catalog team preview: ${result.team.name} (${result.team.key}) agents=${preview.plan.agentPlans.length} projects=${preview.plan.projectPlans.length} issues=${preview.plan.issuePlans.length} warnings=${result.warnings.length} errors=${result.errors.length}`,
  );
  for (const warning of result.warnings) console.log(`warning=${warning}`);
  for (const error of result.errors) console.log(`error=${error}`);
}

function printCatalogTeamInstall(result: CatalogTeamInstallResult | null): void {
  if (!result) {
    console.log("Catalog team install returned no result.");
    return;
  }
  console.log(
    `Catalog team installed: ${result.team.name} (${result.team.key}) agents=${result.portabilityImport.agents.length} projects=${result.portabilityImport.projects.length} warnings=${result.warnings.length}`,
  );
  for (const warning of result.warnings) console.log(`warning=${warning}`);
}

function printInstallApprovalRequested(result: TeamInstallApprovalFallbackResult): void {
  console.log(
    formatInlineRecord({
      status: result.status,
      approvalId: result.approval.id,
      approvalStatus: result.approval.status,
      type: result.approval.type,
      catalogRef: result.installAttempt.catalogRef,
      deniedReason: result.installAttempt.deniedReason,
    }),
  );
  console.log("Install was not performed. The board must approve the request and rerun the install with an authorized token.");
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  const widths = new Map(columns.map((column) => [column, column.length]));
  for (const row of rows) {
    for (const column of columns) {
      widths.set(column, Math.max(widths.get(column) ?? 0, renderTableValue(row[column]).length));
    }
  }
  console.log(columns.map((column) => column.padEnd(widths.get(column) ?? column.length)).join("  "));
  console.log(columns.map((column) => "-".repeat(widths.get(column) ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(
      columns
        .map((column) => renderTableValue(row[column]).padEnd(widths.get(column) ?? column.length))
        .join("  "),
    );
  }
}

function renderTableValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
