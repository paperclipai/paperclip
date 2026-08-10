import { Command } from "commander";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type {
  Company,
  FeedbackTrace,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityImportResult,
} from "@paperclipai/shared";
import {
  companyImportTransferApplyPath,
  companyImportTransferPartPath,
  companyImportTransferPreviewPath,
  COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
  type CompanyImportTransferCreated,
  type CompanyImportTransferDeclaration,
} from "@paperclipai/shared/company-import-transfer";
import { getTelemetryClient, trackCompanyImported } from "../../telemetry.js";
import { ApiRequestError, type PaperclipApiClient } from "../../client/http.js";
import { openUrl } from "../../client/board-auth.js";
import {
  binaryContentTypeByExtension,
  bytesToPortableFileEntry,
  createStoredZipArchive,
  isBlobStorePath,
  readZipArchive,
} from "./zip.js";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import {
  buildFeedbackTraceQuery,
  normalizeFeedbackTraceExportFormat,
  serializeFeedbackTraces,
} from "./feedback.js";

interface CompanyCommandOptions extends BaseClientOptions {}
interface CompanyJsonOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
}
interface AgentMeResponse {
  id: string;
  companyId: string;
}
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
  force?: boolean;
}

interface CompanyFeedbackOptions extends BaseClientOptions {
  targetType?: string;
  vote?: string;
  status?: string;
  projectId?: string;
  issueId?: string;
  from?: string;
  to?: string;
  sharedOnly?: boolean;
  includePayload?: boolean;
  out?: string;
  format?: string;
}

interface CompanyImportOptions extends BaseClientOptions {
  include?: string;
  target?: CompanyImportTargetMode;
  companyId?: string;
  newCompanyName?: string;
  agents?: string;
  collision?: CompanyCollisionMode;
  ref?: string;
  paperclipUrl?: string;
  yes?: boolean;
  dryRun?: boolean;
}

const DEFAULT_EXPORT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: false,
  issues: false,
  skills: false,
};

const DEFAULT_IMPORT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: true,
  issues: true,
  skills: true,
};

const IMPORT_INCLUDE_OPTIONS: Array<{
  value: keyof CompanyPortabilityInclude;
  label: string;
  hint: string;
}> = [
  { value: "company", label: "Company", hint: "name, branding, and company settings" },
  { value: "projects", label: "Projects", hint: "projects and workspace metadata" },
  { value: "issues", label: "Tasks", hint: "tasks and recurring routines" },
  { value: "agents", label: "Agents", hint: "agent records and org structure" },
  { value: "skills", label: "Skills", hint: "company skill packages and references" },
];

const IMPORT_PREVIEW_SAMPLE_LIMIT = 6;

type ImportSelectableGroup = "projects" | "issues" | "agents" | "skills";

type ImportSelectionCatalog = {
  company: {
    includedByDefault: boolean;
    files: string[];
  };
  projects: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  issues: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  agents: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  skills: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  extensionPath: string | null;
};

type ImportSelectionState = {
  company: boolean;
  projects: Set<string>;
  issues: Set<string>;
  agents: Set<string>;
  skills: Set<string>;
};

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

function parseInclude(
  input: string | undefined,
  fallback: CompanyPortabilityInclude = DEFAULT_EXPORT_INCLUDE,
): CompanyPortabilityInclude {
  if (!input || !input.trim()) return { ...fallback };
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

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function resolveImportInclude(input: string | undefined): CompanyPortabilityInclude {
  return parseInclude(input, DEFAULT_IMPORT_INCLUDE);
}

function normalizePortablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function shouldIncludePortableFile(filePath: string): boolean {
  const baseName = path.basename(filePath);
  const isMarkdown = baseName.endsWith(".md");
  const isPaperclipYaml = baseName === ".paperclip.yaml" || baseName === ".paperclip.yml";
  const contentType = binaryContentTypeByExtension[path.extname(baseName).toLowerCase()];
  return isMarkdown || isPaperclipYaml || Boolean(contentType) || isBlobStorePath(filePath);
}

function findPortableExtensionPath(files: Record<string, CompanyPortabilityFileEntry>): string | null {
  if (files[".paperclip.yaml"] !== undefined) return ".paperclip.yaml";
  if (files[".paperclip.yml"] !== undefined) return ".paperclip.yml";
  return Object.keys(files).find((entry) => entry.endsWith("/.paperclip.yaml") || entry.endsWith("/.paperclip.yml")) ?? null;
}

function collectFilesUnderDirectory(
  files: Record<string, CompanyPortabilityFileEntry>,
  directory: string,
  opts?: { excludePrefixes?: string[] },
): string[] {
  const normalizedDirectory = normalizePortablePath(directory).replace(/\/+$/, "");
  if (!normalizedDirectory) return [];
  const prefix = `${normalizedDirectory}/`;
  const excluded = (opts?.excludePrefixes ?? []).map((entry) => normalizePortablePath(entry).replace(/\/+$/, "")).filter(Boolean);
  return Object.keys(files)
    .map(normalizePortablePath)
    .filter((filePath) => filePath.startsWith(prefix))
    .filter((filePath) => !excluded.some((excludePrefix) => filePath.startsWith(`${excludePrefix}/`)))
    .sort((left, right) => left.localeCompare(right));
}

function collectEntityFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  entryPath: string,
  opts?: { excludePrefixes?: string[] },
): string[] {
  const normalizedPath = normalizePortablePath(entryPath);
  const directory = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
  const selected = new Set<string>([normalizedPath]);
  if (directory) {
    for (const filePath of collectFilesUnderDirectory(files, directory, opts)) {
      selected.add(filePath);
    }
  }
  return Array.from(selected).sort((left, right) => left.localeCompare(right));
}

export function buildImportSelectionCatalog(preview: CompanyPortabilityPreviewResult): ImportSelectionCatalog {
  const selectedAgentSlugs = new Set(preview.selectedAgentSlugs);
  const companyFiles = new Set<string>();
  const companyPath = preview.manifest.company?.path ? normalizePortablePath(preview.manifest.company.path) : null;
  if (companyPath) {
    companyFiles.add(companyPath);
  }
  const readmePath = Object.keys(preview.files).find((entry) => normalizePortablePath(entry) === "README.md");
  if (readmePath) {
    companyFiles.add(normalizePortablePath(readmePath));
  }
  const logoPath = preview.manifest.company?.logoPath ? normalizePortablePath(preview.manifest.company.logoPath) : null;
  if (logoPath && preview.files[logoPath] !== undefined) {
    companyFiles.add(logoPath);
  }

  return {
    company: {
      includedByDefault: preview.include.company && preview.manifest.company !== null,
      files: Array.from(companyFiles).sort((left, right) => left.localeCompare(right)),
    },
    projects: preview.manifest.projects.map((project) => {
      const projectPath = normalizePortablePath(project.path);
      const projectDir = projectPath.includes("/") ? projectPath.slice(0, projectPath.lastIndexOf("/")) : "";
      return {
        key: project.slug,
        label: project.name,
        hint: project.slug,
        files: collectEntityFiles(preview.files, projectPath, {
          excludePrefixes: projectDir ? [`${projectDir}/issues`] : [],
        }),
      };
    }),
    issues: preview.manifest.issues.map((issue) => ({
      key: issue.slug,
      label: issue.title,
      hint: issue.identifier ?? issue.slug,
      files: collectEntityFiles(preview.files, normalizePortablePath(issue.path)),
    })),
    agents: preview.manifest.agents
      .filter((agent) => selectedAgentSlugs.size === 0 || selectedAgentSlugs.has(agent.slug))
      .map((agent) => ({
        key: agent.slug,
        label: agent.name,
        hint: agent.slug,
        files: collectEntityFiles(preview.files, normalizePortablePath(agent.path)),
      })),
    skills: preview.manifest.skills.map((skill) => ({
      key: skill.slug,
      label: skill.name,
      hint: skill.slug,
      files: collectEntityFiles(preview.files, normalizePortablePath(skill.path)),
    })),
    extensionPath: findPortableExtensionPath(preview.files),
  };
}

function toKeySet(items: Array<{ key: string }>): Set<string> {
  return new Set(items.map((item) => item.key));
}

export function buildDefaultImportSelectionState(catalog: ImportSelectionCatalog): ImportSelectionState {
  return {
    company: catalog.company.includedByDefault,
    projects: toKeySet(catalog.projects),
    issues: toKeySet(catalog.issues),
    agents: toKeySet(catalog.agents),
    skills: toKeySet(catalog.skills),
  };
}

function countSelected(state: ImportSelectionState, group: ImportSelectableGroup): number {
  return state[group].size;
}

function countTotal(catalog: ImportSelectionCatalog, group: ImportSelectableGroup): number {
  return catalog[group].length;
}

function summarizeGroupSelection(catalog: ImportSelectionCatalog, state: ImportSelectionState, group: ImportSelectableGroup): string {
  return `${countSelected(state, group)}/${countTotal(catalog, group)} selected`;
}

function getGroupLabel(group: ImportSelectableGroup): string {
  switch (group) {
    case "projects":
      return "Projects";
    case "issues":
      return "Tasks";
    case "agents":
      return "Agents";
    case "skills":
      return "Skills";
  }
}

export function buildSelectedFilesFromImportSelection(
  catalog: ImportSelectionCatalog,
  state: ImportSelectionState,
): string[] {
  const selected = new Set<string>();

  if (state.company) {
    for (const filePath of catalog.company.files) {
      selected.add(normalizePortablePath(filePath));
    }
  }

  for (const group of ["projects", "issues", "agents", "skills"] as const) {
    const selectedKeys = state[group];
    for (const item of catalog[group]) {
      if (!selectedKeys.has(item.key)) continue;
      for (const filePath of item.files) {
        selected.add(normalizePortablePath(filePath));
      }
    }
  }

  if (catalog.extensionPath) {
    selected.add(normalizePortablePath(catalog.extensionPath));
  }

  return Array.from(selected).sort((left, right) => left.localeCompare(right));
}

export function buildDefaultImportAdapterOverrides(
  preview: Pick<CompanyPortabilityPreviewResult, "manifest" | "selectedAgentSlugs">,
): Record<string, { adapterType: string }> | undefined {
  const selectedAgentSlugs = new Set(preview.selectedAgentSlugs);
  const overrides = Object.fromEntries(
    preview.manifest.agents
      .filter((agent) => selectedAgentSlugs.size === 0 || selectedAgentSlugs.has(agent.slug))
      .filter((agent) => agent.adapterType === "process")
      .map((agent) => [
        agent.slug,
        {
          // TODO: replace this temporary claude_local fallback with adapter selection in the import TUI.
          adapterType: "claude_local",
        },
      ]),
  );
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function buildDefaultImportAdapterMessages(
  overrides: Record<string, { adapterType: string }> | undefined,
): string[] {
  if (!overrides) return [];
  const adapterTypes = Array.from(new Set(Object.values(overrides).map((override) => override.adapterType)))
    .map((adapterType) => adapterType.replace(/_/g, "-"));
  const agentCount = Object.keys(overrides).length;
  return [
    `Using ${adapterTypes.join(", ")} adapter${adapterTypes.length === 1 ? "" : "s"} for ${agentCount} imported ${pluralize(agentCount, "agent")} without an explicit adapter.`,
  ];
}

async function promptForImportSelection(preview: CompanyPortabilityPreviewResult): Promise<string[]> {
  const catalog = buildImportSelectionCatalog(preview);
  const state = buildDefaultImportSelectionState(catalog);

  while (true) {
    const choice = await p.select<ImportSelectableGroup | "company" | "confirm">({
      message: "Select what Paperclip should import",
      options: [
        {
          value: "company",
          label: state.company ? "Company: included" : "Company: skipped",
          hint: catalog.company.files.length > 0 ? "toggle company metadata" : "no company metadata in package",
        },
        {
          value: "projects",
          label: "Select Projects",
          hint: summarizeGroupSelection(catalog, state, "projects"),
        },
        {
          value: "issues",
          label: "Select Tasks",
          hint: summarizeGroupSelection(catalog, state, "issues"),
        },
        {
          value: "agents",
          label: "Select Agents",
          hint: summarizeGroupSelection(catalog, state, "agents"),
        },
        {
          value: "skills",
          label: "Select Skills",
          hint: summarizeGroupSelection(catalog, state, "skills"),
        },
        {
          value: "confirm",
          label: "Confirm",
          hint: `${buildSelectedFilesFromImportSelection(catalog, state).length} files selected`,
        },
      ],
      initialValue: "confirm",
    });

    if (p.isCancel(choice)) {
      p.cancel("Import cancelled.");
      process.exit(0);
    }

    if (choice === "confirm") {
      const selectedFiles = buildSelectedFilesFromImportSelection(catalog, state);
      if (selectedFiles.length === 0) {
        p.note("Select at least one import target before confirming.", "Nothing selected");
        continue;
      }
      return selectedFiles;
    }

    if (choice === "company") {
      if (catalog.company.files.length === 0) {
        p.note("This package does not include company metadata to toggle.", "No company metadata");
        continue;
      }
      state.company = !state.company;
      continue;
    }

    const group = choice;
    const groupItems = catalog[group];
    if (groupItems.length === 0) {
      p.note(`This package does not include any ${getGroupLabel(group).toLowerCase()}.`, `No ${getGroupLabel(group)}`);
      continue;
    }

    const selection = await p.multiselect<string>({
      message: `${getGroupLabel(group)} to import. Space toggles, enter returns to the main menu.`,
      options: groupItems.map((item) => ({
        value: item.key,
        label: item.label,
        hint: item.hint,
      })),
      initialValues: Array.from(state[group]),
    });

    if (p.isCancel(selection)) {
      p.cancel("Import cancelled.");
      process.exit(0);
    }

    state[group] = new Set(selection);
  }
}

function summarizeInclude(include: CompanyPortabilityInclude): string {
  const labels = IMPORT_INCLUDE_OPTIONS
    .filter((option) => include[option.value])
    .map((option) => option.label.toLowerCase());
  return labels.length > 0 ? labels.join(", ") : "nothing selected";
}

function formatSourceLabel(source: { type: "inline"; rootPath?: string | null } | { type: "github"; url: string }): string {
  if (source.type === "github") {
    return `GitHub: ${source.url}`;
  }
  return `Local package: ${source.rootPath?.trim() || "(current folder)"}`;
}

function formatTargetLabel(
  target: { mode: "existing_company"; companyId?: string | null } | { mode: "new_company"; newCompanyName?: string | null },
  preview?: CompanyPortabilityPreviewResult,
): string {
  if (target.mode === "existing_company") {
    const targetName = preview?.targetCompanyName?.trim();
    const targetId = preview?.targetCompanyId?.trim() || target.companyId?.trim() || "unknown-company";
    return targetName ? `${targetName} (${targetId})` : targetId;
  }
  return target.newCompanyName?.trim() || preview?.manifest.company?.name || "new company";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function summarizePlanCounts(
  plans: Array<{ action: "create" | "update" | "skip" }>,
  noun: string,
): string {
  if (plans.length === 0) return `0 ${pluralize(0, noun)} selected`;
  const createCount = plans.filter((plan) => plan.action === "create").length;
  const updateCount = plans.filter((plan) => plan.action === "update").length;
  const skipCount = plans.filter((plan) => plan.action === "skip").length;
  const parts: string[] = [];
  if (createCount > 0) parts.push(`${createCount} create`);
  if (updateCount > 0) parts.push(`${updateCount} update`);
  if (skipCount > 0) parts.push(`${skipCount} skip`);
  return `${plans.length} ${pluralize(plans.length, noun)} total (${parts.join(", ")})`;
}

function summarizeImportAgentResults(agents: CompanyPortabilityImportResult["agents"]): string {
  if (agents.length === 0) return "0 agents changed";
  const created = agents.filter((agent) => agent.action === "created").length;
  const updated = agents.filter((agent) => agent.action === "updated").length;
  const skipped = agents.filter((agent) => agent.action === "skipped").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${agents.length} ${pluralize(agents.length, "agent")} total (${parts.join(", ")})`;
}

function summarizeImportSkillResults(skills: CompanyPortabilityImportResult["skills"]): string {
  if (skills.length === 0) return "0 skills changed";
  const actions = ["created", "renamed", "replaced", "skipped"] as const;
  const parts = actions.flatMap((action) => {
    const count = skills.filter((skill) => skill.action === action).length;
    return count > 0 ? [`${count} ${action}`] : [];
  });
  return `${skills.length} ${pluralize(skills.length, "skill")} total (${parts.join(", ")})`;
}

function summarizeImportProjectResults(projects: CompanyPortabilityImportResult["projects"]): string {
  if (projects.length === 0) return "0 projects changed";
  const created = projects.filter((project) => project.action === "created").length;
  const updated = projects.filter((project) => project.action === "updated").length;
  const skipped = projects.filter((project) => project.action === "skipped").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${projects.length} ${pluralize(projects.length, "project")} total (${parts.join(", ")})`;
}

function actionChip(action: string): string {
  switch (action) {
    case "create":
    case "created":
      return pc.green(action);
    case "update":
    case "updated":
      return pc.yellow(action);
    case "skip":
    case "skipped":
    case "none":
    case "unchanged":
      return pc.dim(action);
    default:
      return action;
  }
}

function appendPreviewExamples(
  lines: string[],
  title: string,
  entries: Array<{ action: string; label: string; reason?: string | null }>,
): void {
  if (entries.length === 0) return;
  lines.push("");
  lines.push(pc.bold(title));
  const shown = entries.slice(0, IMPORT_PREVIEW_SAMPLE_LIMIT);
  for (const entry of shown) {
    const reason = entry.reason?.trim() ? pc.dim(` (${entry.reason.trim()})`) : "";
    lines.push(`- ${actionChip(entry.action)} ${entry.label}${reason}`);
  }
  if (entries.length > shown.length) {
    lines.push(pc.dim(`- +${entries.length - shown.length} more`));
  }
}

function appendMessageBlock(lines: string[], title: string, messages: string[]): void {
  if (messages.length === 0) return;
  lines.push("");
  lines.push(pc.bold(title));
  for (const message of messages) {
    lines.push(`- ${message}`);
  }
}

export function renderCompanyImportPreview(
  preview: CompanyPortabilityPreviewResult,
  meta: {
    sourceLabel: string;
    targetLabel: string;
    infoMessages?: string[];
  },
): string {
  const lines: string[] = [
    `${pc.bold("Source")}  ${meta.sourceLabel}`,
    `${pc.bold("Target")}  ${meta.targetLabel}`,
    `${pc.bold("Include")} ${summarizeInclude(preview.include)}`,
    `${pc.bold("Mode")}    ${preview.collisionStrategy} collisions`,
    "",
    pc.bold("Package"),
    `- company: ${preview.manifest.company?.name ?? preview.manifest.source?.companyName ?? "not included"}`,
    `- agents: ${preview.manifest.agents.length}`,
    `- projects: ${preview.manifest.projects.length}`,
    `- tasks: ${preview.manifest.issues.length}`,
    `- skills: ${preview.manifest.skills.length}`,
  ];

  if (preview.envInputs.length > 0) {
    const requiredCount = preview.envInputs.filter((item) => item.requirement === "required").length;
    lines.push(`- env inputs: ${preview.envInputs.length} (${requiredCount} required)`);
  }

  lines.push("");
  lines.push(pc.bold("Plan"));
  lines.push(`- company: ${actionChip(preview.plan.companyAction === "none" ? "unchanged" : preview.plan.companyAction)}`);
  lines.push(`- agents: ${summarizePlanCounts(preview.plan.agentPlans, "agent")}`);
  lines.push(`- projects: ${summarizePlanCounts(preview.plan.projectPlans, "project")}`);
  lines.push(`- tasks: ${summarizePlanCounts(preview.plan.issuePlans, "task")}`);
  if (preview.include.skills) {
    lines.push(`- skills: ${preview.manifest.skills.length} ${pluralize(preview.manifest.skills.length, "skill")} packaged`);
  }

  appendPreviewExamples(
    lines,
    "Agent examples",
    preview.plan.agentPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedName}`,
      reason: plan.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Project examples",
    preview.plan.projectPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedName}`,
      reason: plan.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Task examples",
    preview.plan.issuePlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedTitle}`,
      reason: plan.reason,
    })),
  );

  appendMessageBlock(lines, pc.cyan("Info"), meta.infoMessages ?? []);
  appendMessageBlock(lines, pc.yellow("Warnings"), preview.warnings);
  appendMessageBlock(lines, pc.red("Errors"), preview.errors);

  return lines.join("\n");
}

export function renderCompanyImportResult(
  result: CompanyPortabilityImportResult,
  meta: { targetLabel: string; companyUrl?: string; infoMessages?: string[] },
): string {
  const skills = result.skills ?? [];
  const lines: string[] = [
    `${pc.bold("Target")}  ${meta.targetLabel}`,
    `${pc.bold("Company")} ${result.company.name} (${actionChip(result.company.action)})`,
    `${pc.bold("Agents")}  ${summarizeImportAgentResults(result.agents)}`,
    `${pc.bold("Skills")}  ${summarizeImportSkillResults(skills)}`,
    `${pc.bold("Projects")} ${summarizeImportProjectResults(result.projects)}`,
  ];

  if (meta.companyUrl) {
    lines.splice(1, 0, `${pc.bold("URL")}     ${meta.companyUrl}`);
  }

  appendPreviewExamples(
    lines,
    "Agent results",
    result.agents.map((agent) => ({
      action: agent.action,
      label: `${agent.slug} -> ${agent.name}`,
      reason: agent.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Skill results",
    skills.map((skill) => ({
      action: skill.action,
      label: `${skill.originalSlug} -> ${skill.slug}`,
      reason: skill.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Project results",
    result.projects.map((project) => ({
      action: project.action,
      label: `${project.slug} -> ${project.name}`,
      reason: project.reason,
    })),
  );

  if (result.envInputs.length > 0) {
    lines.push("");
    lines.push(pc.bold("Env inputs"));
    lines.push(
      `- ${result.envInputs.length} ${pluralize(result.envInputs.length, "input")} may need values after import`,
    );
  }

  appendMessageBlock(lines, pc.cyan("Info"), meta.infoMessages ?? []);
  appendMessageBlock(lines, pc.yellow("Warnings"), result.warnings);

  return lines.join("\n");
}

function printCompanyImportView(title: string, body: string, opts?: { interactive?: boolean }): void {
  if (opts?.interactive) {
    p.note(body, title);
    return;
  }
  console.log(pc.bold(title));
  console.log(body);
}

export function resolveCompanyImportApiPath(input: {
  dryRun: boolean;
  targetMode: "new_company" | "existing_company";
  companyId?: string | null;
}): string {
  if (input.targetMode === "existing_company") {
    const companyId = input.companyId?.trim();
    if (!companyId) {
      throw new Error("Existing-company imports require a companyId to resolve the API route.");
    }
    return input.dryRun
      ? apiPath`/api/companies/${companyId}/imports/preview`
      : apiPath`/api/companies/${companyId}/imports/apply`;
  }

  return input.dryRun ? "/api/companies/import/preview" : "/api/companies/import";
}

export function buildCompanyDashboardUrl(apiBase: string, issuePrefix: string): string {
  const url = new URL(apiBase);
  const normalizedPrefix = issuePrefix.trim().replace(/^\/+|\/+$/g, "");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${normalizedPrefix}/dashboard`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveCompanyImportApplyConfirmationMode(input: {
  yes?: boolean;
  interactive: boolean;
  json: boolean;
}): "skip" | "prompt" {
  if (input.yes) {
    return "skip";
  }
  if (input.json) {
    throw new Error(
      "Applying a company import with --json requires --yes. Use --dry-run first to inspect the preview.",
    );
  }
  if (!input.interactive) {
    throw new Error(
      "Applying a company import from a non-interactive terminal requires --yes. Use --dry-run first to inspect the preview.",
    );
  }
  return "prompt";
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export function looksLikeRepoUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:") return false;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

function isGithubSegment(input: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(input);
}

export function isGithubShorthand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || isHttpUrl(trimmed)) return false;
  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    return false;
  }

  const segments = trimmed.split("/").filter(Boolean);
  return segments.length >= 2 && segments.every(isGithubSegment);
}

function normalizeGithubImportPath(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || null;
}

function buildGithubImportUrl(input: {
  hostname?: string;
  owner: string;
  repo: string;
  ref?: string | null;
  path?: string | null;
  companyPath?: string | null;
}): string {
  const host = input.hostname || "github.com";
  const url = new URL(`https://${host}/${input.owner}/${input.repo.replace(/\.git$/i, "")}`);
  const ref = input.ref?.trim();
  if (ref) {
    url.searchParams.set("ref", ref);
  }
  const companyPath = normalizeGithubImportPath(input.companyPath);
  if (companyPath) {
    url.searchParams.set("companyPath", companyPath);
    return url.toString();
  }
  const sourcePath = normalizeGithubImportPath(input.path);
  if (sourcePath) {
    url.searchParams.set("path", sourcePath);
  }
  return url.toString();
}

export function normalizeGithubImportSource(input: string, refOverride?: string): string {
  const trimmed = input.trim();
  const ref = refOverride?.trim();

  if (isGithubShorthand(trimmed)) {
    const [owner, repo, ...repoPath] = trimmed.split("/").filter(Boolean);
    return buildGithubImportUrl({
      owner: owner!,
      repo: repo!,
      ref: ref || "main",
      path: repoPath.join("/"),
    });
  }

  if (!looksLikeRepoUrl(trimmed)) {
    throw new Error("GitHub source must be a GitHub or GitHub Enterprise URL, or owner/repo[/path] shorthand.");
  }
  if (!ref) {
    return trimmed;
  }

  const url = new URL(trimmed);
  const hostname = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid GitHub URL.");
  }

  const owner = parts[0]!;
  const repo = parts[1]!;
  const existingPath = normalizeGithubImportPath(url.searchParams.get("path"));
  const existingCompanyPath = normalizeGithubImportPath(url.searchParams.get("companyPath"));
  if (existingCompanyPath) {
    return buildGithubImportUrl({ hostname, owner, repo, ref, companyPath: existingCompanyPath });
  }
  if (existingPath) {
    return buildGithubImportUrl({ hostname, owner, repo, ref, path: existingPath });
  }
  if (parts[2] === "tree") {
    return buildGithubImportUrl({ hostname, owner, repo, ref, path: parts.slice(4).join("/") });
  }
  if (parts[2] === "blob") {
    return buildGithubImportUrl({ hostname, owner, repo, ref, companyPath: parts.slice(4).join("/") });
  }
  return buildGithubImportUrl({ hostname, owner, repo, ref });
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await stat(path.resolve(inputPath));
    return true;
  } catch {
    return false;
  }
}

async function collectPackageFileBytes(
  root: string,
  current: string,
  files: Record<string, Uint8Array>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".git")) continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectPackageFileBytes(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (!shouldIncludePortableFile(relativePath)) continue;
    files[relativePath] = await readFile(absolutePath);
  }
}

export async function resolveInlineSourceFromPath(inputPath: string): Promise<{
  rootPath: string;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const resolved = path.resolve(inputPath);
  const resolvedStat = await stat(resolved);
  if (resolvedStat.isFile() && path.extname(resolved).toLowerCase() === ".zip") {
    const archive = await readZipArchive(await readFile(resolved));
    const filteredFiles = Object.fromEntries(
      Object.entries(archive.files).filter(([relativePath]) => shouldIncludePortableFile(relativePath)),
    );
    return {
      rootPath: archive.rootPath ?? path.basename(resolved, ".zip"),
      files: filteredFiles,
    };
  }

  const rootDir = resolvedStat.isDirectory() ? resolved : path.dirname(resolved);
  const fileBytes: Record<string, Uint8Array> = {};
  await collectPackageFileBytes(rootDir, rootDir, fileBytes);
  return {
    rootPath: path.basename(rootDir),
    files: Object.fromEntries(
      Object.entries(fileBytes).map(([relativePath, bytes]) => [
        relativePath,
        bytesToPortableFileEntry(relativePath, bytes),
      ]),
    ),
  };
}

// ── Chunked transfer flow for large local packages ───────────────────
//
// A local package over the threshold is not posted as one inline JSON body:
// its zip is declared as a chunked transfer (whole-file and per-part sha256),
// the parts are uploaded individually with per-part retries, and preview and
// apply run server-side against the assembled spool. Re-declaring the same
// content — after a failure or an interrupted run — resumes the prior
// transfer, so only the parts the server is missing are ever re-uploaded.

export const CHUNKED_IMPORT_THRESHOLD_BYTES = 48 * 1024 * 1024;
// Imports into an EXISTING company post to /api/companies/:id/imports/*,
// which sits behind the server's default 10 MB JSON parser — only the
// generic /api/companies/import path carries the 64 MB portable limit. The
// chunk decision for existing targets therefore uses this lower threshold
// (margin under 10 MB for the envelope), or the inline body would 413.
export const EXISTING_COMPANY_CHUNKED_IMPORT_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const IMPORT_TRANSFER_PART_SIZE_BYTES = 32 * 1024 * 1024;
const IMPORT_TRANSFER_PART_ATTEMPTS = 3;

// ── Inline request size estimation ───────────────────────────────────
//
// Mirrors `estimateInlineImportBytes` in ui/src/lib/import-preflight.ts (the
// CLI cannot import from ui/) — keep the math on both sides in sync. The
// server enforces its body limit on raw request bytes, so each entry is
// measured the way it actually travels: JSON-escaped UTF-8 for text
// (multi-byte characters and escape sequences both inflate past
// `String.length`), and the base64 payload plus its object structure for
// binary entries (base64 and MIME types are ASCII, one byte per character).

const inlineEstimateUtf8 = new TextEncoder();

// Fixed serialization overhead of a base64 entry object around its data and
// contentType values: {"encoding":"base64","data":"…","contentType":"…"}.
const BASE64_ENTRY_STRUCTURE_BYTES = '{"encoding":"base64","data":"","contentType":""}'.length;

// Allowance for everything in the request body besides the files map itself
// (rootPath, include flags, target, collision strategy, adapter overrides,
// braces and commas). Deliberately generous so the estimate never undercounts.
const REQUEST_ENVELOPE_ALLOWANCE_BYTES = 256 * 1024;

function fileEntryInlineBytes(entry: CompanyPortabilityFileEntry): number {
  if (typeof entry === "string") return inlineEstimateUtf8.encode(JSON.stringify(entry)).length;
  return BASE64_ENTRY_STRUCTURE_BYTES + entry.data.length + (entry.contentType?.length ?? 0);
}

/**
 * Approximate JSON request size of an inline import: JSON-escaped UTF-8 text
 * bytes, base64 payloads with their entry structure, the serialized file-path
 * keys (thousands of paths are real bytes), and an envelope allowance for the
 * rest of the request body.
 */
function estimateInlineImportBytes(files: Record<string, CompanyPortabilityFileEntry>): number {
  let total = REQUEST_ENVELOPE_ALLOWANCE_BYTES;
  for (const [filePath, entry] of Object.entries(files)) {
    // "path": entry,  → key bytes + colon + comma.
    total += inlineEstimateUtf8.encode(JSON.stringify(filePath)).length + 2 + fileEntryInlineBytes(entry);
  }
  return total;
}

export interface ImportTransferUploadProgress {
  uploadedParts: number;
  totalParts: number;
  uploadedBytes: number;
  totalBytes: number;
}

export function buildImportTransferManifest(zipBytes: Uint8Array): CompanyImportTransferDeclaration {
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const parts: CompanyImportTransferDeclaration["parts"] = [];
  for (let offset = 0; offset < zipBytes.length; offset += IMPORT_TRANSFER_PART_SIZE_BYTES) {
    const byteSize = Math.min(IMPORT_TRANSFER_PART_SIZE_BYTES, zipBytes.length - offset);
    parts.push({
      index: parts.length,
      byteSize,
      sha256: sha256(zipBytes.subarray(offset, offset + byteSize)),
    });
  }
  return {
    totalBytes: zipBytes.length,
    zipSha256: sha256(zipBytes),
    partSizeBytes: IMPORT_TRANSFER_PART_SIZE_BYTES,
    parts,
  };
}

/**
 * Resolve a local import source into raw zip bytes when its package is too
 * large to travel as one inline JSON body: a .zip file is read as-is (so its
 * declared hashes match the file on disk), a folder is packaged as a stored
 * zip in memory with the same walk filters the inline path uses. Both source
 * kinds are measured twice — raw bytes as a fast path, then the estimated
 * inline request size, because base64 inflates binary entries ~4/3 and a
 * compressed zip can expand far past its file size. Returns null for sources
 * under the threshold on both measures — those keep the inline JSON path.
 */
export async function resolveChunkedImportZip(
  inputPath: string,
  thresholdBytes: number = CHUNKED_IMPORT_THRESHOLD_BYTES,
): Promise<{
  zipBytes: Uint8Array;
  rootPath: string;
} | null> {
  const resolved = path.resolve(inputPath);
  const resolvedStat = await stat(resolved);
  if (resolvedStat.isFile() && path.extname(resolved).toLowerCase() === ".zip") {
    const zipBytes = new Uint8Array(await readFile(resolved));
    const rootPath = path.basename(resolved, ".zip");
    if (resolvedStat.size > thresholdBytes) return { zipBytes, rootPath };
    // A small compressed zip can still expand past server caps as inline
    // JSON (text compresses well and binary re-inflates ~4/3 as base64), so
    // the stay-inline decision uses the estimated request size of the same
    // entries the inline path would send. An unreadable zip stays inline so
    // that path surfaces its canonical parse error.
    let archive: Awaited<ReturnType<typeof readZipArchive>>;
    try {
      archive = await readZipArchive(zipBytes);
    } catch {
      return null;
    }
    if (estimateInlineImportBytes(archive.files) <= thresholdBytes) return null;
    return { zipBytes, rootPath };
  }
  if (!resolvedStat.isDirectory()) return null;
  const fileBytes: Record<string, Uint8Array> = {};
  await collectPackageFileBytes(resolved, resolved, fileBytes);
  const rootPath = path.basename(resolved);
  // Content bytes alone already past the threshold means the stored zip
  // (content plus headers) is too.
  const contentBytes = Object.values(fileBytes).reduce((sum, bytes) => sum + bytes.length, 0);
  if (contentBytes <= thresholdBytes) {
    // Raw bytes under the threshold can still blow past server caps once the
    // inline body is built (binary entries travel base64-inflated), so the
    // stay-inline decision is made on the estimated request size — the same
    // entries the inline path would send.
    const inlineEntries = Object.fromEntries(
      Object.entries(fileBytes).map(([relativePath, bytes]) => [
        relativePath,
        bytesToPortableFileEntry(relativePath, bytes),
      ]),
    );
    if (estimateInlineImportBytes(inlineEntries) <= thresholdBytes) return null;
  }
  return { zipBytes: createStoredZipArchive(fileBytes, rootPath), rootPath };
}

/**
 * Declare (or resume) the transfer for these zip bytes and upload every part
 * the server reports missing, sequentially with per-part retries. Resolves
 * with the transfer id once the server holds every part.
 */
export async function uploadCompanyImportTransfer(
  api: Pick<PaperclipApiClient, "post" | "putRaw">,
  zipBytes: Uint8Array,
  opts: { onProgress?: (progress: ImportTransferUploadProgress) => void } = {},
): Promise<string> {
  const manifest = buildImportTransferManifest(zipBytes);
  const created = await api.post<CompanyImportTransferCreated>(
    `/api/companies${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}`,
    manifest,
  );
  if (!created) {
    throw new Error("Import transfer declaration returned no data.");
  }
  if (created.alreadyCompleted) {
    // The server keys transfers by content, and this exact zip already
    // finished an apply — its spooled parts are gone, so it cannot re-run.
    throw new Error(
      "This exact package was already imported by a completed transfer. Re-export the package to import it again.",
    );
  }
  const missing = new Set(created.missingParts);
  let uploadedParts = manifest.parts.length - missing.size;
  let uploadedBytes = manifest.parts.reduce(
    (sum, part) => (missing.has(part.index) ? sum : sum + part.byteSize),
    0,
  );
  for (const part of manifest.parts) {
    if (!missing.has(part.index)) continue;
    const offset = part.index * manifest.partSizeBytes;
    const bytes = zipBytes.subarray(offset, offset + part.byteSize);
    let lastError: unknown = null;
    let uploaded = false;
    for (let attempt = 0; attempt < IMPORT_TRANSFER_PART_ATTEMPTS && !uploaded; attempt += 1) {
      try {
        await api.putRaw(
          `/api/companies${companyImportTransferPartPath(created.transferId, part.index)}`,
          bytes,
        );
        uploaded = true;
      } catch (err) {
        lastError = err;
      }
    }
    if (!uploaded) {
      // Parts already uploaded stay spooled server-side; re-running the
      // import resumes from them instead of starting over.
      throw lastError instanceof Error
        ? lastError
        : new Error(`Import transfer part ${part.index} failed to upload.`);
    }
    uploadedParts += 1;
    uploadedBytes += part.byteSize;
    opts.onProgress?.({
      uploadedParts,
      totalParts: manifest.parts.length,
      uploadedBytes,
      totalBytes: manifest.totalBytes,
    });
  }
  return created.transferId;
}

export async function writeExportToFolder(outDir: string, exported: CompanyPortabilityExportResult): Promise<void> {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(exported.files)) {
    const normalized = relativePath.replace(/\\/g, "/");
    const filePath = resolveExportOutputPath(root, normalized);
    await mkdir(path.dirname(filePath), { recursive: true });
    const writeValue = portableFileEntryToWriteValue(content);
    if (typeof writeValue === "string") {
      await writeFile(filePath, writeValue, "utf8");
    } else {
      await writeFile(filePath, writeValue);
    }
  }
}

export function resolveExportOutputPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, relativePath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (filePath !== resolvedRoot && !filePath.startsWith(rootPrefix)) {
    throw new Error(`Refusing to write export file outside output directory: ${relativePath}`);
  }
  return filePath;
}

export async function confirmOverwriteExportDirectory(
  outDir: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const root = path.resolve(outDir);
  const stats = await stat(root).catch(() => null);
  if (!stats) return;
  if (!stats.isDirectory()) {
    throw new Error(`Export output path ${root} exists and is not a directory.`);
  }

  const entries = await readdir(root);
  if (entries.length === 0) return;

  // --force skips the guard for non-interactive/automated callers (e.g. the
  // nightly backup routine, which exports into a git clone that legitimately
  // still holds .git and BACKUP-README.md after cleaning tracked content).
  if (opts.force) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Export output directory ${root} already contains files. Re-run interactively, pass --force, or choose an empty directory.`);
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
          const rows = await listCompaniesForContext(ctx);
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
          const row = await ctx.api.get<Company>(apiPath`/api/companies/${companyId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("current")
      .description("Get the current scoped company from --company-id, context, env, or agent authentication")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const companyId = await resolveCurrentCompanyId(ctx);
          const row = await ctx.api.get<Company>(apiPath`/api/companies/${companyId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    company
      .command("stats")
      .description("Get company stats")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/companies/stats"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("create")
      .description("Create a company")
      .requiredOption("--payload-json <json>", "CreateCompany JSON payload")
      .action(async (opts: CompanyJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await createCompanyForContext(ctx, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("update")
      .description("Update a company")
      .argument("<companyId>", "Company ID")
      .requiredOption("--payload-json <json>", "UpdateCompany JSON payload")
      .action(async (companyId: string, opts: CompanyJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(apiPath`/api/companies/${companyId}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("branding:update")
      .description("Update company branding")
      .argument("<companyId>", "Company ID")
      .requiredOption("--payload-json <json>", "UpdateCompanyBranding JSON payload")
      .action(async (companyId: string, opts: CompanyJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(apiPath`/api/companies/${companyId}/branding`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("archive")
      .description("Archive a company")
      .argument("<companyId>", "Company ID")
      .action(async (companyId: string, opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/companies/${companyId}/archive`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCompanyJsonPost(company, "export:preview", "Preview a portable company export", "exports/preview");
  addCompanyJsonPost(company, "export:api", "Export a company through the raw API route", "exports");
  addCompanyJsonPost(company, "import:preview", "Preview a safe company import through the raw API route", "imports/preview");
  addCompanyJsonPost(company, "import:apply", "Apply a safe company import through the raw API route", "imports/apply");

  addCommonClientOptions(
    company
      .command("feedback:list")
      .description("List feedback traces for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--target-type <type>", "Filter by target type")
      .option("--vote <vote>", "Filter by vote value")
      .option("--status <status>", "Filter by trace status")
      .option("--project-id <id>", "Filter by project ID")
      .option("--issue-id <id>", "Filter by issue ID")
      .option("--from <iso8601>", "Only include traces created at or after this timestamp")
      .option("--to <iso8601>", "Only include traces created at or before this timestamp")
      .option("--shared-only", "Only include traces eligible for sharing/export")
      .option("--include-payload", "Include stored payload snapshots in the response")
      .action(async (opts: CompanyFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/companies/${ctx.companyId}/feedback-traces`}${buildFeedbackTraceQuery(opts)}`,
          )) ?? [];
          if (ctx.json) {
            printOutput(traces, { json: true });
            return;
          }
          printOutput(
            traces.map((trace) => ({
              id: trace.id,
              issue: trace.issueIdentifier ?? trace.issueId,
              vote: trace.vote,
              status: trace.status,
              targetType: trace.targetType,
              target: trace.targetSummary.label,
            })),
            { json: false },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    company
      .command("feedback:export")
      .description("Export feedback traces for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--target-type <type>", "Filter by target type")
      .option("--vote <vote>", "Filter by vote value")
      .option("--status <status>", "Filter by trace status")
      .option("--project-id <id>", "Filter by project ID")
      .option("--issue-id <id>", "Filter by issue ID")
      .option("--from <iso8601>", "Only include traces created at or after this timestamp")
      .option("--to <iso8601>", "Only include traces created at or before this timestamp")
      .option("--shared-only", "Only include traces eligible for sharing/export")
      .option("--include-payload", "Include stored payload snapshots in the export")
      .option("--out <path>", "Write export to a file path instead of stdout")
      .option("--format <format>", "Export format: json or ndjson", "ndjson")
      .action(async (opts: CompanyFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/companies/${ctx.companyId}/feedback-traces`}${buildFeedbackTraceQuery(opts, opts.includePayload ?? true)}`,
          )) ?? [];
          const serialized = serializeFeedbackTraces(traces, opts.format);
          if (opts.out?.trim()) {
            await writeFile(opts.out, serialized, "utf8");
            if (ctx.json) {
              printOutput(
                { out: opts.out, count: traces.length, format: normalizeFeedbackTraceExportFormat(opts.format) },
                { json: true },
              );
              return;
            }
            console.log(`Wrote ${traces.length} feedback trace(s) to ${opts.out}`);
            return;
          }
          process.stdout.write(`${serialized}${serialized.endsWith("\n") ? "" : "\n"}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
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
      .option(
        "--force",
        "Overwrite a non-empty output directory without the interactive confirmation (required for non-interactive/automated runs such as the nightly backup routine)",
        false,
      )
      .action(async (companyId: string, opts: CompanyExportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const include = parseInclude(opts.include);
          const exported = await ctx.api.post<CompanyPortabilityExportResult>(
            apiPath`/api/companies/${companyId}/export`,
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
          await confirmOverwriteExportDirectory(opts.out!, { force: Boolean(opts.force) });
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
      .argument("<fromPathOrUrl>", "Source path or URL")
      .option("--include <values>", "Comma-separated include set: company,agents,projects,issues,tasks,skills")
      .option("--target <mode>", "Target mode: new | existing")
      .option("-C, --company-id <id>", "Existing target company ID")
      .option("--new-company-name <name>", "Name override for --target new")
      .option("--agents <list>", "Comma-separated agent slugs to import, or all", "all")
      .option("--collision <mode>", "Collision strategy: rename | skip | replace", "rename")
      .option("--ref <value>", "Git ref to use for GitHub imports (branch, tag, or commit)")
      .option("--paperclip-url <url>", "Alias for --api-base on this command")
      .option("--yes", "Accept default selection and skip the pre-import confirmation prompt", false)
      .option("--dry-run", "Run preview only without applying", false)
      .action(async (fromPathOrUrl: string, opts: CompanyImportOptions) => {
        try {
          if (!opts.apiBase?.trim() && opts.paperclipUrl?.trim()) {
            opts.apiBase = opts.paperclipUrl.trim();
          }
          const ctx = resolveCommandContext(opts);
          const interactiveView = isInteractiveTerminal() && !ctx.json;
          const from = fromPathOrUrl.trim();
          if (!from) {
            throw new Error("Source path or URL is required.");
          }

          const include = resolveImportInclude(opts.include);
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
          let chunkedZip: { zipBytes: Uint8Array; rootPath: string } | null = null;

          const treatAsLocalPath = !isHttpUrl(from) && await pathExists(from);
          const isGithubSource = looksLikeRepoUrl(from) || (isGithubShorthand(from) && !treatAsLocalPath);

          if (isHttpUrl(from) || isGithubSource) {
            if (!looksLikeRepoUrl(from) && !isGithubShorthand(from)) {
              throw new Error(
                "Only GitHub URLs and local paths are supported for import. " +
                "Generic HTTP URLs are not supported. Use a GitHub or GitHub Enterprise URL (https://github.com/... or https://ghe.example.com/...) or a local directory path.",
              );
            }
            sourcePayload = { type: "github", url: normalizeGithubImportSource(from, opts.ref) };
          } else {
            if (opts.ref?.trim()) {
              throw new Error("--ref is only supported for GitHub import sources.");
            }
            chunkedZip = await resolveChunkedImportZip(
              from,
              target === "existing"
                ? EXISTING_COMPANY_CHUNKED_IMPORT_THRESHOLD_BYTES
                : CHUNKED_IMPORT_THRESHOLD_BYTES,
            );
            if (chunkedZip) {
              // Too large for one request: the zip travels as a chunked
              // transfer, so the inline files map is never built or sent.
              sourcePayload = { type: "inline", rootPath: chunkedZip.rootPath, files: {} };
            } else {
              const inline = await resolveInlineSourceFromPath(from);
              sourcePayload = {
                type: "inline",
                rootPath: inline.rootPath,
                files: inline.files,
              };
            }
          }

          const sourceLabel = formatSourceLabel(sourcePayload);
          const targetLabel = formatTargetLabel(targetPayload);
          const previewApiPath = resolveCompanyImportApiPath({
            dryRun: true,
            targetMode: targetPayload.mode,
            companyId: targetPayload.mode === "existing_company" ? targetPayload.companyId : null,
          });

          // The transfer meta mirrors the inline preview payload minus its
          // `source` — the source is the assembled zip, spooled server-side.
          const transferMeta = {
            include,
            target: targetPayload,
            agents,
            collisionStrategy: collision,
          };
          let transferId: string | null = null;
          if (chunkedZip) {
            transferId = await uploadCompanyImportTransfer(ctx.api, chunkedZip.zipBytes, {
              onProgress: ctx.json
                ? undefined
                : ({ uploadedParts, totalParts, uploadedBytes, totalBytes }) => {
                    console.log(
                      pc.dim(
                        `Uploaded part ${uploadedParts}/${totalParts} (${Math.round(uploadedBytes / (1024 * 1024))} of ${Math.round(totalBytes / (1024 * 1024))} MB)`,
                      ),
                    );
                  },
            });
          }
          const transferPreviewPath = transferId
            ? `/api/companies${companyImportTransferPreviewPath(transferId)}`
            : null;

          let selectedFiles: string[] | undefined;
          if (interactiveView && !opts.yes && !opts.include?.trim()) {
            const initialPreview = transferPreviewPath
              ? await ctx.api.post<CompanyPortabilityPreviewResult>(transferPreviewPath, transferMeta)
              : await ctx.api.post<CompanyPortabilityPreviewResult>(previewApiPath, {
                  source: sourcePayload,
                  ...transferMeta,
                });
            if (!initialPreview) {
              throw new Error("Import preview returned no data.");
            }
            selectedFiles = await promptForImportSelection(initialPreview);
          }

          const previewPayload = {
            source: sourcePayload,
            ...transferMeta,
            selectedFiles,
          };
          const preview = transferPreviewPath
            ? await ctx.api.post<CompanyPortabilityPreviewResult>(transferPreviewPath, {
                ...transferMeta,
                selectedFiles,
              })
            : await ctx.api.post<CompanyPortabilityPreviewResult>(previewApiPath, previewPayload);
          if (!preview) {
            throw new Error("Import preview returned no data.");
          }
          const adapterOverrides = buildDefaultImportAdapterOverrides(preview);
          const adapterMessages = buildDefaultImportAdapterMessages(adapterOverrides);

          if (opts.dryRun) {
            if (ctx.json) {
              printOutput(preview, { json: true });
            } else {
              printCompanyImportView(
                "Import Preview",
                renderCompanyImportPreview(preview, {
                  sourceLabel,
                  targetLabel: formatTargetLabel(targetPayload, preview),
                  infoMessages: adapterMessages,
                }),
                { interactive: interactiveView },
              );
            }
            return;
          }

          if (!ctx.json) {
            printCompanyImportView(
              "Import Preview",
              renderCompanyImportPreview(preview, {
                sourceLabel,
                targetLabel: formatTargetLabel(targetPayload, preview),
                infoMessages: adapterMessages,
              }),
              { interactive: interactiveView },
            );
          }

          const confirmationMode = resolveCompanyImportApplyConfirmationMode({
            yes: opts.yes,
            interactive: interactiveView,
            json: ctx.json,
          });
          if (confirmationMode === "prompt") {
            const confirmed = await p.confirm({
              message: "Apply this import? (y/N)",
              initialValue: false,
            });
            if (p.isCancel(confirmed) || !confirmed) {
              p.log.warn("Import cancelled.");
              return;
            }
          }

          const importApiPath = resolveCompanyImportApiPath({
            dryRun: false,
            targetMode: targetPayload.mode,
            companyId: targetPayload.mode === "existing_company" ? targetPayload.companyId : null,
          });
          const imported = transferId
            ? await ctx.api.post<CompanyPortabilityImportResult>(
                `/api/companies${companyImportTransferApplyPath(transferId)}`,
                { ...transferMeta, selectedFiles, adapterOverrides },
              )
            : await ctx.api.post<CompanyPortabilityImportResult>(importApiPath, {
                ...previewPayload,
                adapterOverrides,
              });
          if (!imported) {
            throw new Error("Import request returned no data.");
          }
          const tc = getTelemetryClient();
          if (tc) {
            const isPrivate = sourcePayload.type !== "github";
            const sourceRef = sourcePayload.type === "github" ? sourcePayload.url : from;
            trackCompanyImported(tc, { sourceType: sourcePayload.type, sourceRef, isPrivate });
          }
          let companyUrl: string | undefined;
          if (!ctx.json) {
            try {
              const importedCompany = await ctx.api.get<Company>(apiPath`/api/companies/${imported.company.id}`);
              const issuePrefix = importedCompany?.issuePrefix?.trim();
              if (issuePrefix) {
                companyUrl = buildCompanyDashboardUrl(ctx.api.apiBase, issuePrefix);
              }
            } catch {
              companyUrl = undefined;
            }
          }
          if (ctx.json) {
            printOutput(imported, { json: true });
          } else {
            printCompanyImportView(
              "Import Result",
              renderCompanyImportResult(imported, {
                targetLabel,
                companyUrl,
                infoMessages: adapterMessages,
              }),
              { interactive: interactiveView },
            );
            if (interactiveView && companyUrl) {
              const openImportedCompany = await p.confirm({
                message: "Open the imported company in your browser?",
                initialValue: true,
              });
              if (!p.isCancel(openImportedCompany) && openImportedCompany) {
                if (await openUrl(companyUrl)) {
                  p.log.info(`Opened ${companyUrl}`);
                } else {
                  p.log.warn(`Could not open your browser automatically. Open this URL manually:\n${companyUrl}`);
                }
              }
            }
          }
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
            const byId = await ctx.api.get<Company>(apiPath`/api/companies/${normalizedSelector}`, { ignoreNotFound: true });
            if (byId) {
              target = byId;
            } else if (by === "id") {
              throw new Error(`No company found by ID '${normalizedSelector}'.`);
            }
          }

          if (!target && ctx.companyId) {
            const scoped = await ctx.api.get<Company>(apiPath`/api/companies/${ctx.companyId}`, { ignoreNotFound: true });
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

          await ctx.api.delete<{ ok: true }>(apiPath`/api/companies/${target.id}`);

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

async function listCompaniesForContext(ctx: {
  companyId?: string;
  api: { get<T>(path: string): Promise<T | null> };
}): Promise<Company[]> {
  try {
    return (await ctx.api.get<Company[]>("/api/companies")) ?? [];
  } catch (error) {
    if (!isBoardAccessRequiredError(error)) {
      throw error;
    }
  }

  const companyId = await resolveCurrentCompanyId(ctx);
  const scopedCompany = await ctx.api.get<Company>(apiPath`/api/companies/${companyId}`);
  return scopedCompany ? [scopedCompany] : [];
}

async function createCompanyForContext(ctx: {
  api: { post<T>(path: string, body?: unknown): Promise<T | null> };
}, payload: unknown): Promise<unknown> {
  try {
    return await ctx.api.post("/api/companies", payload);
  } catch (error) {
    if (isBoardAccessRequiredError(error) || isInstanceAdminRequiredError(error)) {
      throw new Error(
        "Creating companies requires board/instance-admin authentication. Agent API keys are scoped to one company; use `paperclipai company list --json` or `paperclipai company current --json` to select the scoped company, or rerun create with a board token/login.",
      );
    }
    throw error;
  }
}

async function resolveCurrentCompanyId(ctx: { companyId?: string; api: { get<T>(path: string): Promise<T | null> } }): Promise<string> {
  const fromContext = ctx.companyId?.trim();
  if (fromContext) return fromContext;

  let agent: AgentMeResponse | null = null;
  try {
    agent = await ctx.api.get<AgentMeResponse>("/api/agents/me");
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
      throw new Error(
        "Current company is not available. Pass --company-id, set PAPERCLIP_COMPANY_ID, set a context profile companyId, or authenticate with an agent API key.",
      );
    }
    throw error;
  }

  const fromAgent = agent?.companyId?.trim();
  if (fromAgent) return fromAgent;
  throw new Error(
    "Current company is not available. Pass --company-id, set PAPERCLIP_COMPANY_ID, set a context profile companyId, or authenticate with an agent API key.",
  );
}

function isBoardAccessRequiredError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 403 && error.message.toLowerCase().includes("board access required");
}

function isInstanceAdminRequiredError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 403 && error.message.toLowerCase().includes("instance admin");
}

function addCompanyJsonPost(parent: Command, name: string, description: string, pathSuffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<companyId>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (companyId: string, opts: CompanyJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(`${apiPath`/api/companies/${companyId}`}/${pathSuffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
