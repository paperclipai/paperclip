import { Command } from "commander";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import type {
  Company,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityImportResult,
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
  skills?: string;
  projects?: string;
  issues?: string;
  projectIssues?: string;
  expandReferencedSkills?: boolean;
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

const binaryContentTypeByExtension: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function readPortableFileEntry(filePath: string, contents: Buffer): CompanyPortabilityFileEntry {
  const contentType = binaryContentTypeByExtension[path.extname(filePath).toLowerCase()];
  if (!contentType) return contents.toString("utf8");
  return {
    encoding: "base64",
    data: contents.toString("base64"),
    contentType,
  };
}

function portableFileEntryToWriteValue(entry: CompanyPortabilityFileEntry): string | Uint8Array {
  if (typeof entry === "string") return entry;
  return Buffer.from(entry.data, "base64");
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeSelector(input: string): string {
  return input.trim();
}

function parseInclude(input: string | undefined): CompanyPortabilityInclude {
  if (!input || !input.trim()) return { company: true, agents: true, projects: false, issues: false, skills: false };
  const values = input.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const include = {
    company: values.includes("company"),
    agents: values.includes("agents"),
    projects: values.includes("projects"),
    issues: values.includes("issues") || values.includes("tasks"),
    skills: values.includes("skills"),
  };
  if (!include.company && !include.agents && !include.projects && !include.issues && !include.skills) {
    throw new Error("Invalid --include value. Use one or more of: company,agents,projects,issues,tasks,skills");
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

function parseCsvValues(input: string | undefined): string[] {
  if (!input || !input.trim()) return [];
  return Array.from(new Set(input.split(",").map((part) => part.trim()).filter(Boolean)));
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export function isGithubUrl(input: string): boolean {
  return /^https?:\/\/github\.com\//i.test(input.trim());
}

async function collectPackageFiles(
  root: string,
  current: string,
  files: Record<string, CompanyPortabilityFileEntry>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".git")) continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectPackageFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const isMarkdown = entry.name.endsWith(".md");
    const isPaperclipYaml = entry.name === ".paperclip.yaml" || entry.name === ".paperclip.yml";
    const contentType = binaryContentTypeByExtension[path.extname(entry.name).toLowerCase()];
    if (!isMarkdown && !isPaperclipYaml && !contentType) continue;
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    files[relativePath] = readPortableFileEntry(relativePath, await readFile(absolutePath));
  }
}

async function resolveInlineSourceFromPath(inputPath: string): Promise<{
  rootPath: string;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const resolved = path.resolve(inputPath);
  const resolvedStat = await stat(resolved);
  const rootDir = resolvedStat.isDirectory() ? resolved : path.dirname(resolved);
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  await collectPackageFiles(rootDir, rootDir, files);
  return {
    rootPath: path.basename(rootDir),
    files,
  };
}

async function writeExportToFolder(outDir: string, exported: CompanyPortabilityExportResult): Promise<void> {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(exported.files)) {
    const normalized = relativePath.replace(/\\/g, "/");
    const filePath = path.join(root, normalized);
    await mkdir(path.dirname(filePath), { recursive: true });
    const writeValue = portableFileEntryToWriteValue(content);
    if (typeof writeValue === "string") {
      await writeFile(filePath, writeValue, "utf8");
    } else {
      await writeFile(filePath, writeValue);
    }
  }
}

async function confirmOverwriteExportDirectory(outDir: string): Promise<void> {
  const root = path.resolve(outDir);
  const stats = await stat(root).catch(() => null);
  if (!stats) return;
  if (!stats.isDirectory()) {
    throw new Error(`Export output path ${root} exists and is not a directory.`);
  }

  const entries = await readdir(root);
  if (entries.length === 0) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Export output directory ${root} already contains files. Re-run interactively or choose an empty directory.`);
  }

  const confirmed = await p.confirm({
    message: `Overwrite existing files in ${root}?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    throw new Error("Export cancelled.");
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
      .description("Export a company into a portable markdown package")
      .argument("<companyId>", "Company ID")
      .requiredOption("--out <path>", "Output directory")
      .option("--include <values>", "Comma-separated include set: company,agents,projects,issues,tasks,skills", "company,agents")
      .option("--skills <values>", "Comma-separated skill slugs/keys to export")
      .option("--projects <values>", "Comma-separated project shortnames/ids to export")
      .option("--issues <values>", "Comma-separated issue identifiers/ids to export")
      .option("--project-issues <values>", "Comma-separated project shortnames/ids whose issues should be exported")
      .option("--expand-referenced-skills", "Vendor skill contents instead of exporting upstream references", false)
      .action(async (companyId: string, opts: CompanyExportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const include = parseInclude(opts.include);
          const exported = await ctx.api.post<CompanyPortabilityExportResult>(
            `/api/companies/${companyId}/export`,
            {
              include,
              skills: parseCsvValues(opts.skills),
              projects: parseCsvValues(opts.projects),
              issues: parseCsvValues(opts.issues),
              projectIssues: parseCsvValues(opts.projectIssues),
              expandReferencedSkills: Boolean(opts.expandReferencedSkills),
            },
          );
          if (!exported) {
            throw new Error("Export request returned no data");
          }
          await confirmOverwriteExportDirectory(opts.out!);
          await writeExportToFolder(opts.out!, exported);
          printOutput(
            {
              ok: true,
              out: path.resolve(opts.out!),
              rootPath: exported.rootPath,
              filesWritten: Object.keys(exported.files).length,
              paperclipExtensionPath: exported.paperclipExtensionPath,
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
      .description("Import a portable markdown company package from local path, URL, or GitHub")
      .requiredOption("--from <pathOrUrl>", "Source path or URL")
      .option("--include <values>", "Comma-separated include set: company,agents,projects,issues,tasks,skills", "company,agents")
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

          const include = parseInclude(opts.include);
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

          let sourcePayload:
            | { type: "inline"; rootPath?: string | null; files: Record<string, CompanyPortabilityFileEntry> }
            | { type: "github"; url: string };

          if (isHttpUrl(from)) {
            if (!isGithubUrl(from)) {
              throw new Error(
                "Only GitHub URLs and local paths are supported for import. " +
                "Generic HTTP URLs are not supported. Use a GitHub URL (https://github.com/...) or a local directory path.",
              );
            }
            sourcePayload = { type: "github", url: from };
          } else {
            const inline = await resolveInlineSourceFromPath(from);
            sourcePayload = {
              type: "inline",
              rootPath: inline.rootPath,
              files: inline.files,
            };
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
