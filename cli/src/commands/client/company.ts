import { Command } from "commander";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Company,
  CompanyPortabilityExportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilitySource,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityImportResult,
  CompanyTemplateCatalogEntry,
  CompanyTemplateDetail,
} from "@paperclipai/shared";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyCommandOptions extends BaseClientOptions {}
type CompanyDeleteSelectorMode = "auto" | "id" | "prefix";
type CompanyImportTargetMode = "new" | "existing";
type CompanyCollisionMode = "rename" | "skip" | "replace";

interface CompanyDeleteOptions extends BaseClientOptions {
  by?: CompanyDeleteSelectorMode;
  yes?: boolean;
  confirm?: string;
}

interface CompanyExportOptions extends BaseClientOptions {
  out?: string;
  include?: string;
}

interface CompanyImportOptions extends BaseClientOptions {
  from?: string;
  include?: string;
  target?: CompanyImportTargetMode;
  companyId?: string;
  newCompanyName?: string;
  agents?: string;
  collision?: CompanyCollisionMode;
  dryRun?: boolean;
}

const DEFAULT_PORTABILITY_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  goals: false,
  projects: false,
  issues: false,
};

const FULL_TEMPLATE_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  goals: true,
  projects: true,
  issues: true,
};

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeSelector(input: string): string {
  return input.trim();
}

function parseInclude(
  input: string | undefined,
  defaults: CompanyPortabilityInclude = DEFAULT_PORTABILITY_INCLUDE,
): CompanyPortabilityInclude {
  if (!input || !input.trim()) return defaults;
  const values = input.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const include = {
    company: values.includes("company"),
    agents: values.includes("agents"),
    goals: values.includes("goals"),
    projects: values.includes("projects"),
    issues: values.includes("issues"),
  };
  if (!include.company && !include.agents && !include.goals && !include.projects && !include.issues) {
    throw new Error("Invalid --include value. Use one or more of: company,agents,goals,projects,issues");
  }
  return include;
}

function parseAgents(input: string | undefined): "all" | string[] {
  if (!input || !input.trim()) return "all";
  const normalized = input.trim().toLowerCase();
  if (normalized === "all") return "all";
  const values = input.split(",").map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) return "all";
  return Array.from(new Set(values));
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function isGithubUrl(input: string): boolean {
  return /^https?:\/\/github\.com\//i.test(input.trim());
}

export function parseBuiltinTemplateRef(input: string): string | null {
  const normalized = input.trim();
  if (!/^builtin:/i.test(normalized)) return null;
  const templateId = normalized.slice("builtin:".length).trim();
  if (!templateId) {
    throw new Error("Built-in template source requires a template ID, for example builtin:solo-founder-lite.");
  }
  return templateId;
}

async function resolveInlineSourceFromPath(inputPath: string): Promise<{
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
}> {
  const resolved = path.resolve(inputPath);
  const resolvedStat = await stat(resolved);
  const manifestPath = resolvedStat.isDirectory()
    ? path.join(resolved, "paperclip.manifest.json")
    : resolved;
  const manifestBaseDir = path.dirname(manifestPath);
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as CompanyPortabilityManifest;
  const files: Record<string, string> = {};

  if (manifest.company?.path) {
    const companyPath = manifest.company.path.replace(/\\/g, "/");
    files[companyPath] = await readFile(path.join(manifestBaseDir, companyPath), "utf8");
  }
  for (const agent of manifest.agents ?? []) {
    const agentPath = agent.path.replace(/\\/g, "/");
    files[agentPath] = await readFile(path.join(manifestBaseDir, agentPath), "utf8");
  }

  return { manifest, files };
}

export async function resolveCompanyImportSource(from: string): Promise<CompanyPortabilitySource> {
  const builtinTemplateId = parseBuiltinTemplateRef(from);
  if (builtinTemplateId) {
    return {
      type: "builtin",
      templateId: builtinTemplateId,
    };
  }

  if (isHttpUrl(from)) {
    return isGithubUrl(from)
      ? { type: "github", url: from }
      : { type: "url", url: from };
  }

  const inline = await resolveInlineSourceFromPath(from);
  return {
    type: "inline",
    manifest: inline.manifest,
    files: inline.files,
  };
}

async function writeExportToFolder(outDir: string, exported: CompanyPortabilityExportResult): Promise<void> {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const manifestPath = path.join(root, "paperclip.manifest.json");
  await writeFile(manifestPath, JSON.stringify(exported.manifest, null, 2), "utf8");
  for (const [relativePath, content] of Object.entries(exported.files)) {
    const normalized = relativePath.replace(/\\/g, "/");
    const filePath = path.join(root, normalized);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function matchesPrefix(company: Company, selector: string): boolean {
  return company.issuePrefix.toUpperCase() === selector.toUpperCase();
}

export function resolveCompanyForDeletion(
  companies: Company[],
  selectorRaw: string,
  by: CompanyDeleteSelectorMode = "auto",
): Company {
  const selector = normalizeSelector(selectorRaw);
  if (!selector) {
    throw new Error("Company selector is required.");
  }

  const idMatch = companies.find((company) => company.id === selector);
  const prefixMatch = companies.find((company) => matchesPrefix(company, selector));

  if (by === "id") {
    if (!idMatch) {
      throw new Error(`No company found by ID '${selector}'.`);
    }
    return idMatch;
  }

  if (by === "prefix") {
    if (!prefixMatch) {
      throw new Error(`No company found by shortname/prefix '${selector}'.`);
    }
    return prefixMatch;
  }

  if (idMatch && prefixMatch && idMatch.id !== prefixMatch.id) {
    throw new Error(
      `Selector '${selector}' is ambiguous (matches both an ID and a shortname). Re-run with --by id or --by prefix.`,
    );
  }

  if (idMatch) return idMatch;
  if (prefixMatch) return prefixMatch;

  throw new Error(
    `No company found for selector '${selector}'. Use company ID or issue prefix (for example PAP).`,
  );
}

export function assertDeleteConfirmation(company: Company, opts: CompanyDeleteOptions): void {
  if (!opts.yes) {
    throw new Error("Deletion requires --yes.");
  }

  const confirm = opts.confirm?.trim();
  if (!confirm) {
    throw new Error(
      "Deletion requires --confirm <value> where value matches the company ID or issue prefix.",
    );
  }

  const confirmsById = confirm === company.id;
  const confirmsByPrefix = confirm.toUpperCase() === company.issuePrefix.toUpperCase();
  if (!confirmsById && !confirmsByPrefix) {
    throw new Error(
      `Confirmation '${confirm}' does not match target company. Expected ID '${company.id}' or prefix '${company.issuePrefix}'.`,
    );
  }
}

function assertDeleteFlags(opts: CompanyDeleteOptions): void {
  if (!opts.yes) {
    throw new Error("Deletion requires --yes.");
  }
  if (!opts.confirm?.trim()) {
    throw new Error(
      "Deletion requires --confirm <value> where value matches the company ID or issue prefix.",
    );
  }
}

export function registerCompanyCommands(program: Command): void {
  const company = program.command("company").description("Company operations");
  const templates = company.command("templates").description("Built-in company templates");

  addCommonClientOptions(
    templates
      .command("list")
      .description("List built-in company templates")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<CompanyTemplateCatalogEntry[]>("/api/templates")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(formatInlineRecord({
              id: row.id,
              name: row.name,
              category: row.category,
              maturity: row.maturity,
              agentCount: row.agentCount,
              recommended: row.recommended,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    templates
      .command("get")
      .description("Get one built-in company template")
      .argument("<templateId>", "Template ID")
      .action(async (templateId: string, opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<CompanyTemplateDetail>(`/api/templates/${encodeURIComponent(templateId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("list")
      .description("List companies")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Company[]>("/api/companies")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          const formatted = rows.map((row) => ({
            id: row.id,
            name: row.name,
            status: row.status,
            budgetMonthlyCents: row.budgetMonthlyCents,
            spentMonthlyCents: row.spentMonthlyCents,
            requireBoardApprovalForNewAgents: row.requireBoardApprovalForNewAgents,
          }));
          for (const row of formatted) {
            console.log(formatInlineRecord(row));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("get")
      .description("Get one company")
      .argument("<companyId>", "Company ID")
      .action(async (companyId: string, opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Company>(`/api/companies/${companyId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("export")
      .description("Export a company into portable manifest + markdown files")
      .argument("<companyId>", "Company ID")
      .requiredOption("--out <path>", "Output directory")
      .option("--include <values>", "Comma-separated include set: company,agents,goals,projects,issues", "company,agents")
      .action(async (companyId: string, opts: CompanyExportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const include = parseInclude(opts.include, DEFAULT_PORTABILITY_INCLUDE);
          const exported = await ctx.api.post<CompanyPortabilityExportResult>(
            `/api/companies/${companyId}/export`,
            { include },
          );
          if (!exported) {
            throw new Error("Export request returned no data");
          }
          await writeExportToFolder(opts.out!, exported);
          printOutput(
            {
              ok: true,
              out: path.resolve(opts.out!),
              filesWritten: Object.keys(exported.files).length + 1,
              warningCount: exported.warnings.length,
            },
            { json: ctx.json },
          );
          if (!ctx.json && exported.warnings.length > 0) {
            for (const warning of exported.warnings) {
              console.log(`warning=${warning}`);
            }
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("import")
      .description("Import a portable company package from local path, URL, GitHub, or builtin:<template-id>")
      .requiredOption("--from <pathOrUrl>", "Source path, URL, or builtin:<template-id>")
      .option("--include <values>", "Comma-separated include set: company,agents,goals,projects,issues")
      .option("--target <mode>", "Target mode: new | existing")
      .option("-C, --company-id <id>", "Existing target company ID")
      .option("--new-company-name <name>", "Name override for --target new")
      .option("--agents <list>", "Comma-separated agent slugs to import, or all", "all")
      .option("--collision <mode>", "Collision strategy: rename | skip | replace", "rename")
      .option("--dry-run", "Run preview only without applying", false)
      .action(async (opts: CompanyImportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const from = (opts.from ?? "").trim();
          if (!from) {
            throw new Error("--from is required");
          }

          const sourcePayload = await resolveCompanyImportSource(from);
          const includeDefaults =
            sourcePayload.type === "builtin"
              ? FULL_TEMPLATE_INCLUDE
              : DEFAULT_PORTABILITY_INCLUDE;
          const include = parseInclude(opts.include, includeDefaults);
          const agents = parseAgents(opts.agents);
          const collision = (opts.collision ?? "rename").toLowerCase() as CompanyCollisionMode;
          if (!["rename", "skip", "replace"].includes(collision)) {
            throw new Error("Invalid --collision value. Use: rename, skip, replace");
          }

          const inferredTarget = opts.target ?? (opts.companyId || ctx.companyId ? "existing" : "new");
          const target = inferredTarget.toLowerCase() as CompanyImportTargetMode;
          if (!["new", "existing"].includes(target)) {
            throw new Error("Invalid --target value. Use: new | existing");
          }

          const existingTargetCompanyId = opts.companyId?.trim() || ctx.companyId;
          const targetPayload =
            target === "existing"
              ? {
                  mode: "existing_company" as const,
                  companyId: existingTargetCompanyId,
                }
              : {
                  mode: "new_company" as const,
                  newCompanyName: opts.newCompanyName?.trim() || null,
                };

          if (targetPayload.mode === "existing_company" && !targetPayload.companyId) {
            throw new Error("Target existing company requires --company-id (or context default companyId).");
          }

          const payload = {
            source: sourcePayload,
            include,
            target: targetPayload,
            agents,
            collisionStrategy: collision,
          };

          if (opts.dryRun) {
            const preview = await ctx.api.post<CompanyPortabilityPreviewResult>(
              "/api/companies/import/preview",
              payload,
            );
            printOutput(preview, { json: ctx.json });
            return;
          }

          const imported = await ctx.api.post<CompanyPortabilityImportResult>("/api/companies/import", payload);
          printOutput(imported, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("delete")
      .description("Delete a company by ID or shortname/prefix (destructive)")
      .argument("<selector>", "Company ID or issue prefix (for example PAP)")
      .option(
        "--by <mode>",
        "Selector mode: auto | id | prefix",
        "auto",
      )
      .option("--yes", "Required safety flag to confirm destructive action", false)
      .option(
        "--confirm <value>",
        "Required safety value: target company ID or shortname/prefix",
      )
      .action(async (selector: string, opts: CompanyDeleteOptions) => {
        try {
          const by = (opts.by ?? "auto").trim().toLowerCase() as CompanyDeleteSelectorMode;
          if (!["auto", "id", "prefix"].includes(by)) {
            throw new Error(`Invalid --by mode '${opts.by}'. Expected one of: auto, id, prefix.`);
          }

          const ctx = resolveCommandContext(opts);
          const normalizedSelector = normalizeSelector(selector);
          assertDeleteFlags(opts);

          let target: Company | null = null;
          const shouldTryIdLookup = by === "id" || (by === "auto" && isUuidLike(normalizedSelector));
          if (shouldTryIdLookup) {
            const byId = await ctx.api.get<Company>(`/api/companies/${normalizedSelector}`, { ignoreNotFound: true });
            if (byId) {
              target = byId;
            } else if (by === "id") {
              throw new Error(`No company found by ID '${normalizedSelector}'.`);
            }
          }

          if (!target && ctx.companyId) {
            const scoped = await ctx.api.get<Company>(`/api/companies/${ctx.companyId}`, { ignoreNotFound: true });
            if (scoped) {
              try {
                target = resolveCompanyForDeletion([scoped], normalizedSelector, by);
              } catch {
                // Fallback to board-wide lookup below.
              }
            }
          }

          if (!target) {
            try {
              const companies = (await ctx.api.get<Company[]>("/api/companies")) ?? [];
              target = resolveCompanyForDeletion(companies, normalizedSelector, by);
            } catch (error) {
              if (error instanceof ApiRequestError && error.status === 403 && error.message.includes("Board access required")) {
                throw new Error(
                  "Board access is required to resolve companies across the instance. Use a company ID/prefix for your current company, or run with board authentication.",
                );
              }
              throw error;
            }
          }

          if (!target) {
            throw new Error(`No company found for selector '${normalizedSelector}'.`);
          }

          assertDeleteConfirmation(target, opts);

          await ctx.api.delete<{ ok: true }>(`/api/companies/${target.id}`);

          printOutput(
            {
              ok: true,
              deletedCompanyId: target.id,
              deletedCompanyName: target.name,
              deletedCompanyPrefix: target.issuePrefix,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
