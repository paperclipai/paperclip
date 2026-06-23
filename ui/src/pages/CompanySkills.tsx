import { useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { t, useTranslation } from "@/i18n";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentDesiredSkillEntry,
  Agent,
  CatalogSkill,
  CatalogSkillFileDetail,
  CatalogSkillSource,
  CompanySkillCompatibility,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillSharingScope,
  CompanySkillSourceBadge,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
  CompanySkillVersion,
} from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { CopyText } from "../components/CopyText";
import { Identity } from "../components/Identity";
import { AgentIcon } from "../components/AgentIconPicker";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { cn, relativeTime } from "../lib/utils";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import {
  parseSkillRoute,
  skillRoute,
  withRouteSkill,
  resolveSkillRouteToken,
  type CompanySkillRouteSubject,
} from "../lib/company-skill-routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  ArrowUpCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Eye,
  Filter,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  Github,
  Globe,
  HelpCircle,
  LayoutGrid,
  Link2,
  Lock,
  ExternalLink,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Plus,
  Copy,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  History,
  XOctagon,
} from "lucide-react";

type SkillTreeNode = {
  name: string;
  path: string | null;
  kind: "dir" | "file";
  fileKind?: CompanySkillFileInventoryEntry["kind"];
  children: SkillTreeNode[];
};

const SKILL_TREE_BASE_INDENT = 16;
const SKILL_TREE_STEP_INDENT = 24;
const SKILL_TREE_ROW_HEIGHT_CLASS = "min-h-9";

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 4 21 19H3z" />
    </svg>
  );
}

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
  };
}

function mergeFrontmatter(markdown: string, body: string) {
  const parsed = splitFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

function buildTree(entries: CompanySkillFileInventoryEntry[]) {
  const root: SkillTreeNode = { name: "", path: null, kind: "dir", children: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let next = current.children.find((child) => child.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: isLeaf ? entry.path : currentPath,
          kind: isLeaf ? "file" : "dir",
          fileKind: isLeaf ? entry.kind : undefined,
          children: [],
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  function sortNode(node: SkillTreeNode) {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (left.name === "SKILL.md") return -1;
      if (right.name === "SKILL.md") return 1;
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortNode);
  }

  sortNode(root);
  return root.children;
}

function sourceMeta(sourceBadge: CompanySkillSourceBadge, sourceLabel: string | null) {
  const normalizedLabel = sourceLabel?.toLowerCase() ?? "";
  const isSkillsShManaged =
    normalizedLabel.includes("skills.sh") || normalizedLabel.includes("vercel-labs/skills");

  switch (sourceBadge) {
    case "skills_sh":
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: t("pages.companySkills.managedSkillsSh", { defaultValue: "skills.sh managed" }) };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: t("pages.companySkills.managedSkillsSh", { defaultValue: "skills.sh managed" }) }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: t("pages.companySkills.managedGithub", { defaultValue: "GitHub managed" }) };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: t("pages.companySkills.managedUrl", { defaultValue: "URL managed" }) };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: t("pages.companySkills.managedFolder", { defaultValue: "Folder managed" }) };
    case "paperclip":
      return { icon: Paperclip, label: sourceLabel ?? "Paperclip", managedLabel: t("pages.companySkills.managedPaperclip", { defaultValue: "Paperclip managed" }) };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: t("pages.companySkills.managedCatalog", { defaultValue: "Catalog managed" }) };
  }
}

function shortRef(ref: string | null | undefined) {
  if (!ref) return null;
  return ref.slice(0, 7);
}

function middleTruncate(value: string, maxLength = 72) {
  if (value.length <= maxLength) return value;
  const edgeLength = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, edgeLength)}...${value.slice(value.length - edgeLength)}`;
}

function formatProjectScanSummary(result: CompanySkillProjectScanResult) {
  const parts = [
    t("pages.companySkills.scanSummaryFound", { count: result.discovered, defaultValue: "{{count}} found" }),
    t("pages.companySkills.scanSummaryImported", { count: result.imported.length, defaultValue: "{{count}} imported" }),
    t("pages.companySkills.scanSummaryUpdated", { count: result.updated.length, defaultValue: "{{count}} updated" }),
  ];
  if (result.conflicts.length > 0) parts.push(t("pages.companySkills.scanSummaryConflicts", { count: result.conflicts.length, defaultValue: "{{count}} conflicts" }));
  if (result.skipped.length > 0) parts.push(t("pages.companySkills.scanSummarySkipped", { count: result.skipped.length, defaultValue: "{{count}} skipped" }));
  return t("pages.companySkills.scanSummaryAcross", {
    parts: parts.join(t("pages.companySkills.listSeparator", { defaultValue: ", " })),
    count: result.scannedWorkspaces,
    defaultValue: "{{parts}} across {{count}} workspaces.",
  });
}

function fileIcon(kind: CompanySkillFileInventoryEntry["kind"]) {
  if (kind === "script" || kind === "reference") return FileCode2;
  return FileText;
}

function catalogSkillRoute(catalogRef: string) {
  return `/skills?view=catalog&catalog=${encodeURIComponent(catalogRef)}`;
}

function parentDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return parents;
}

type SourceFilter = "all" | "company" | "bundled" | "optional" | "external";

function sourceFilterLabel(filter: SourceFilter): string {
  switch (filter) {
    case "company":
      return t("pages.companySkills.sourceFilterCompany", { defaultValue: "Company" });
    case "bundled":
      return t("pages.companySkills.sourceFilterBundled", { defaultValue: "Bundled" });
    case "optional":
      return t("pages.companySkills.sourceFilterOptional", { defaultValue: "Optional" });
    case "external":
      return t("pages.companySkills.sourceFilterExternal", { defaultValue: "External" });
    case "all":
    default:
      return t("pages.companySkills.sourceFilterAll", { defaultValue: "All" });
  }
}

function readonlyMetadataValue(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readonlyMetadataKind(metadata: Record<string, unknown> | null | undefined): "bundled" | "optional" | null {
  const value = readonlyMetadataValue(metadata, "sourceKind") ?? readonlyMetadataValue(metadata, "catalogKind");
  if (value === "bundled") return "bundled";
  if (value === "optional") return "optional";
  return null;
}

function classifySource(skill: {
  sourceBadge: CompanySkillSourceBadge;
  sourceType: string;
  catalogKind?: "bundled" | "optional" | null;
  metadata?: Record<string, unknown> | null;
}): SourceFilter {
  if (skill.sourceBadge === "paperclip") return "company";
  if (skill.sourceType === "local_path" && !skill.sourceBadge.toString().includes("github")) {
    return "company";
  }
  if (skill.sourceType === "catalog" || skill.sourceBadge === "catalog") {
    const kind = skill.catalogKind ?? readonlyMetadataKind(skill.metadata);
    if (kind === "bundled") return "bundled";
    if (kind === "optional") return "optional";
    return "company";
  }
  if (skill.sourceBadge === "github" || skill.sourceBadge === "skills_sh" || skill.sourceBadge === "url" || skill.sourceBadge === "local") {
    return "external";
  }
  return "company";
}

function SourceFilterMenu({
  counts,
  value,
  onChange,
}: {
  counts: Record<SourceFilter, number>;
  value: SourceFilter;
  onChange: (next: SourceFilter) => void;
}) {
  const { t } = useTranslation();
  const filters: SourceFilter[] = ["all", "company", "bundled", "optional", "external"];
  const activeFilterCount = value === "all" ? 0 : 1;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("relative shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? t("pages.companySkills.filtersActiveTitle", { count: activeFilterCount, defaultValue: "Filters: {{count}}" }) : t("pages.companySkills.filterTitle", { defaultValue: "Filter" })}
        >
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t("pages.companySkills.sourceLabel", { defaultValue: "Source" })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as SourceFilter)}>
          {filters.map((filter) => (
            <DropdownMenuRadioItem key={filter} value={filter}>
              <span>{sourceFilterLabel(filter)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{counts[filter] ?? 0}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CatalogFilterMenu({
  kindFilter,
  categoryFilter,
  categories,
  onKindChange,
  onCategoryChange,
}: {
  kindFilter: "all" | "bundled" | "optional";
  categoryFilter: string;
  categories: string[];
  onKindChange: (next: "all" | "bundled" | "optional") => void;
  onCategoryChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const activeFilterCount = (kindFilter === "all" ? 0 : 1) + (categoryFilter ? 1 : 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("relative shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? t("pages.companySkills.filtersActiveTitle", { count: activeFilterCount, defaultValue: "Filters: {{count}}" }) : t("pages.companySkills.filterTitle", { defaultValue: "Filter" })}
        >
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(28rem,70vh)] w-56 overflow-y-auto">
        <DropdownMenuLabel>{t("pages.companySkills.typeLabel", { defaultValue: "Type" })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={kindFilter} onValueChange={(next) => onKindChange(next as "all" | "bundled" | "optional")}>
          <DropdownMenuRadioItem value="all">{t("pages.companySkills.typeAll", { defaultValue: "All" })}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bundled">{t("pages.companySkills.typeBundled", { defaultValue: "Bundled" })}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="optional">{t("pages.companySkills.typeOptional", { defaultValue: "Optional" })}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("pages.companySkills.categoryLabel", { defaultValue: "Category" })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={categoryFilter || "__all__"} onValueChange={(next) => onCategoryChange(next === "__all__" ? "" : next)}>
          <DropdownMenuRadioItem value="__all__">{t("pages.companySkills.allCategories", { defaultValue: "All categories" })}</DropdownMenuRadioItem>
          {categories.map((category) => (
            <DropdownMenuRadioItem key={category} value={category}>
              {category}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrustChip({ level }: { level: CompanySkillTrustLevel }) {
  const { t } = useTranslation();
  const map = {
    markdown_only: {
      icon: ShieldCheck,
      label: t("pages.companySkills.trustMarkdownOnlyLabel", { defaultValue: "Markdown only" }),
      tooltip: t("pages.companySkills.trustMarkdownOnlyTooltip", { defaultValue: "Text only — no scripts, no binaries, no assets." }),
      className: "border-border bg-muted/40 text-muted-foreground",
    },
    assets: {
      icon: Folder,
      label: t("pages.companySkills.trustAssetsLabel", { defaultValue: "Includes assets" }),
      tooltip: t("pages.companySkills.trustAssetsTooltip", { defaultValue: "Ships images, fonts, or other non-script files." }),
      className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-200",
    },
    scripts_executables: {
      icon: AlertTriangle,
      label: t("pages.companySkills.trustScriptsLabel", { defaultValue: "Includes scripts" }),
      tooltip: t("pages.companySkills.trustScriptsTooltip", { defaultValue: "Ships executable scripts. Review before installing." }),
      className: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    },
  } as const;
  const config = map[level] ?? map.markdown_only;
  const Icon = config.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", config.className)}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {config.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function CompatChip({ compatibility }: { compatibility: CompanySkillCompatibility }) {
  const { t } = useTranslation();
  if (compatibility === "compatible") return null;
  const map = {
    unknown: {
      icon: HelpCircle,
      label: t("pages.companySkills.compatUnknownLabel", { defaultValue: "Unknown format" }),
      tooltip: t("pages.companySkills.compatUnknownTooltip", { defaultValue: "Paperclip could not validate this skill as Agent Skills markdown. Install at your own risk." }),
      className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-200",
    },
    invalid: {
      icon: XOctagon,
      label: t("pages.companySkills.compatInvalidLabel", { defaultValue: "Invalid" }),
      tooltip: t("pages.companySkills.compatInvalidTooltip", { defaultValue: "This skill cannot be installed — content is not valid Agent Skills markdown." }),
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    },
  } as const;
  const config = map[compatibility];
  const Icon = config.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", config.className)}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {config.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ProvenanceBadge({ packageName, packageVersion }: { packageName: string | null; packageVersion: string | null }) {
  const { t } = useTranslation();
  if (!packageName) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          <Boxes className="h-3 w-3" aria-hidden="true" />
          <span>{packageName}{packageVersion ? ` v${packageVersion}` : ""}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("pages.companySkills.provenanceTooltip", { defaultValue: "Installed from the app-shipped skills catalog. Provenance is signed by package version and content hash." })}</TooltipContent>
    </Tooltip>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Skills Store discovery grid (PAP-10879)
// ---------------------------------------------------------------------------

type DiscoveryTab = "all" | "installed" | "catalog" | "bundled";

const DISCOVERY_TABS: DiscoveryTab[] = ["all", "installed", "catalog", "bundled"];

type DiscoverySort = "agents" | "stars" | "forks" | "recent" | "alphabetical";

function discoverySortLabel(sort: DiscoverySort): string {
  switch (sort) {
    case "stars":
      return t("pages.companySkills.sortMostStars", { defaultValue: "Most stars" });
    case "forks":
      return t("pages.companySkills.sortMostForks", { defaultValue: "Most forks" });
    case "recent":
      return t("pages.companySkills.sortRecentlyUpdated", { defaultValue: "Recently updated" });
    case "alphabetical":
      return t("pages.companySkills.sortAlphabetical", { defaultValue: "Alphabetical" });
    case "agents":
    default:
      return t("pages.companySkills.sortMostAgents", { defaultValue: "Most agents" });
  }
}

const DISCOVERY_SORTS: DiscoverySort[] = ["agents", "stars", "forks", "recent", "alphabetical"];

export type DiscoveryCard = {
  key: string;
  skillId: string | null;
  catalogRef: string | null;
  name: string;
  slug: string;
  author: string;
  version: string | null;
  tagline: string | null;
  description: string | null;
  categories: string[];
  iconUrl: string | null;
  color: string | null;
  starCount: number;
  agentCount: number;
  forkCount: number;
  installed: boolean;
  required: boolean;
  forkedFrom: boolean;
  updatedAt: number;
  sourceBadge?: CompanySkillSourceBadge | null;
  sourceLabel?: string | null;
};

// Stable palette used to auto-assign an accent colour to a skill when the
// backend has not stored an explicit one. Colour is derived from the skill key
// so the same skill always lands on the same hue.
const DISCOVERY_ACCENTS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#22c55e",
  "#3b82f6", "#a855f7",
];

function skillAccentColor(key: string, explicit: string | null | undefined): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return DISCOVERY_ACCENTS[hash % DISCOVERY_ACCENTS.length];
}

function SkillCardIcon({ card, size = 36 }: { card: DiscoveryCard; size?: number }) {
  if (card.iconUrl) {
    return (
      <img
        src={card.iconUrl}
        alt=""
        className="shrink-0 rounded-md object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const accent = skillAccentColor(card.key, card.color);
  const letter = (card.slug || card.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-md font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: accent, fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </span>
  );
}

function discoveryVersionLabel(skill: {
  packageVersion: string | null;
  sourceRef: string | null;
}, required: boolean): string | null {
  if (skill.packageVersion) return `v${skill.packageVersion}`;
  if (required) return t("pages.companySkills.versionCore", { defaultValue: "core" });
  if (skill.sourceRef) return shortRef(skill.sourceRef);
  return null;
}

function uniqueCategories(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const slug = value?.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function normalizeSkillDraftSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function splitCategoryDraft(value: string) {
  return value
    .split(",")
    .map((entry) => normalizeSkillDraftSlug(entry))
    .filter(Boolean);
}

function defaultSkillMarkdown(name: string, tagline: string) {
  const title = name.trim() || t("pages.companySkills.defaultSkillTitle", { defaultValue: "New Skill" });
  const summary = tagline.trim() || t("pages.companySkills.defaultSkillSummary", { defaultValue: "Describe when agents should use this skill." });
  return [
    "---",
    `name: ${title}`,
    `description: ${summary}`,
    "---",
    "",
    `# ${title}`,
    "",
    summary,
    "",
    `## ${t("pages.companySkills.defaultSkillWhenToUseHeading", { defaultValue: "When To Use" })}`,
    "",
    `- ${t("pages.companySkills.defaultSkillWhenToUseBullet", { defaultValue: "Use this skill when the task needs its specialized workflow." })}`,
    "",
    `## ${t("pages.companySkills.defaultSkillWorkflowHeading", { defaultValue: "Workflow" })}`,
    "",
    `1. ${t("pages.companySkills.defaultSkillWorkflowStep1", { defaultValue: "Inspect the task context." })}`,
    `2. ${t("pages.companySkills.defaultSkillWorkflowStep2", { defaultValue: "Apply the workflow carefully." })}`,
    `3. ${t("pages.companySkills.defaultSkillWorkflowStep3", { defaultValue: "Report what changed and how it was verified." })}`,
    "",
  ].join("\n");
}

// Merge installed company skills and the install catalog into one card model.
// Installed skills win on dedup (they carry the richer social-proof metadata);
// catalog-only skills fill in the rest of the discoverable surface.
function buildDiscoveryCards(
  installed: CompanySkillListItem[],
  catalog: CatalogSkill[],
): DiscoveryCard[] {
  const catalogByKey = new Map(catalog.map((entry) => [entry.key, entry]));
  const cards: DiscoveryCard[] = [];
  const installedKeys = new Set<string>();

  for (const skill of installed) {
    installedKeys.add(skill.key);
    const catalogMatch = catalogByKey.get(skill.key) ?? null;
    const required = skill.catalogKind === "bundled" || catalogMatch?.kind === "bundled";
    cards.push({
      key: skill.key,
      skillId: skill.id,
      catalogRef: catalogMatch ? catalogMatch.id : null,
      name: skill.name,
      slug: skill.slug,
      author: skill.authorName ?? skill.sourceLabel ?? t("pages.companySkills.authorYou", { defaultValue: "you" }),
      version: discoveryVersionLabel(skill, required),
      tagline: skill.tagline ?? null,
      description: skill.description ?? null,
      categories: uniqueCategories([...(skill.categories ?? []), catalogMatch?.category]),
      iconUrl: skill.iconUrl,
      color: skill.color,
      starCount: skill.starCount ?? 0,
      agentCount: skill.attachedAgentCount ?? 0,
      forkCount: skill.forkCount ?? 0,
      installed: true,
      required,
      forkedFrom: Boolean(skill.forkedFromSkillId),
      updatedAt: new Date(skill.updatedAt).getTime() || 0,
      sourceBadge: skill.sourceBadge,
      sourceLabel: skill.sourceLabel,
    });
  }

  for (const entry of catalog) {
    if (installedKeys.has(entry.key)) continue;
    const required = entry.kind === "bundled";
    cards.push({
      key: entry.key,
      skillId: null,
      catalogRef: entry.id,
      name: entry.name,
      slug: entry.slug,
      author: entry.packageName ?? "Paperclip",
      version: discoveryVersionLabel({ packageVersion: entry.packageVersion ?? null, sourceRef: null }, required),
      tagline: null,
      description: entry.description,
      categories: uniqueCategories([entry.category, ...(entry.tags ?? [])]),
      iconUrl: null,
      color: null,
      starCount: 0,
      agentCount: 0,
      forkCount: 0,
      installed: false,
      required,
      forkedFrom: false,
      updatedAt: 0,
      sourceBadge: "catalog",
      sourceLabel: entry.packageName ?? "Catalog",
    });
  }

  return cards;
}

function cardsForTab(cards: DiscoveryCard[], tab: DiscoveryTab): DiscoveryCard[] {
  switch (tab) {
    case "installed":
      return cards.filter((card) => card.installed);
    case "catalog":
      return cards.filter((card) => card.catalogRef != null);
    case "bundled":
      return cards.filter((card) => card.required);
    case "all":
    default:
      return cards;
  }
}

function sortDiscoveryCards(cards: DiscoveryCard[], sort: DiscoverySort, demoteRequired: boolean): DiscoveryCard[] {
  const byName = (a: DiscoveryCard, b: DiscoveryCard) => a.name.localeCompare(b.name);
  const sorted = [...cards].sort((a, b) => {
    // Bundled/required skills are demoted out of discovery rankings (except on
    // the Bundled tab, where they are the whole point).
    if (demoteRequired && a.required !== b.required) return a.required ? 1 : -1;
    switch (sort) {
      case "stars":
        return b.starCount - a.starCount || byName(a, b);
      case "forks":
        return b.forkCount - a.forkCount || byName(a, b);
      case "recent":
        return b.updatedAt - a.updatedAt || byName(a, b);
      case "alphabetical":
        return byName(a, b);
      case "agents":
      default:
        return b.agentCount - a.agentCount || byName(a, b);
    }
  });
  return sorted;
}

function discoveryMatchesSearch(card: DiscoveryCard, query: string): boolean {
  if (!query) return true;
  const haystack = [
    card.name,
    card.slug,
    card.author,
    card.tagline ?? "",
    card.description ?? "",
    card.categories.join(" "),
  ].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function SkillStat({ icon: Icon, value }: { icon: typeof Star; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {value}
    </span>
  );
}

function SkillCategoryChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
      {label}
    </span>
  );
}

function SkillCard({ card, onOpen }: { card: DiscoveryCard; onOpen: (card: DiscoveryCard) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      className={cn(
        "group flex h-full min-h-[11.5rem] flex-col rounded-md border border-border p-4 text-left transition-colors hover:border-primary hover:bg-accent/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        card.required && "bg-muted/30",
      )}
    >
      <div className="flex items-start gap-3">
        <SkillCardIcon card={card} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-foreground">{card.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {t("pages.companySkills.cardByAuthor", { author: card.author, defaultValue: "by {{author}}" })}{card.version ? ` · ${card.version}` : ""}
          </div>
        </div>
        {/* Where the skill came from (PAP-10907 E); native title gives a hover hint. */}
        {(() => {
          const meta = sourceMeta(card.sourceBadge ?? "catalog", card.sourceLabel ?? null);
          const SourceIcon = meta.icon;
          const fromSourceLabel = t("pages.companySkills.cardFromSource", { source: meta.label, defaultValue: "From {{source}}" });
          return (
            <span className="shrink-0 text-muted-foreground" title={fromSourceLabel} aria-label={fromSourceLabel}>
              <SourceIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          );
        })()}
      </div>

      {card.forkedFrom ? (
        <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <GitFork className="h-3 w-3" aria-hidden="true" />
          {t("pages.companySkills.cardForked", { defaultValue: "Forked" })}
        </div>
      ) : null}

      {/* Always reserve two lines so cards line up even without a description. */}
      <p className="mt-2 line-clamp-2 min-h-8 text-xs text-muted-foreground">
        {resolveSkillSummaryText({
          tagline: card.tagline,
          description: card.description,
          key: card.key,
          name: card.name,
        }) ?? ""}
      </p>

      <div className="mt-auto pt-3">
        {/* Stats: installed agents · stars · forks — stars/forks only when > 0. */}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{t("pages.companySkills.agentCount", { count: card.agentCount, defaultValue: "{{count}} agents" })}</span>
          {card.starCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <SkillStat icon={Star} value={String(card.starCount)} />
            </>
          ) : null}
          {card.forkCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <SkillStat icon={GitFork} value={String(card.forkCount)} />
            </>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {card.installed ? (
            <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
              {t("pages.companySkills.cardInstalled", { defaultValue: "Installed" })}
            </span>
          ) : null}
          {card.categories.slice(0, 2).map((category) => (
            <SkillCategoryChip key={category} label={category} />
          ))}
          {card.required ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden="true" />
              {t("pages.companySkills.cardBundled", { defaultValue: "Bundled" })}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export type DiscoveryCategory = { slug: string; count: number };

function CategoryNav({
  categories,
  total,
  active,
  onSelect,
}: {
  categories: DiscoveryCategory[];
  total: number;
  active: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="flex flex-col gap-0.5 px-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/40",
          active == null ? "bg-accent/60 font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        <span>{t("pages.companySkills.categoryNavAll", { defaultValue: "All" })}</span>
        <span className="text-xs text-muted-foreground">{total}</span>
      </button>
      {categories.map((category) => (
        <button
          key={category.slug}
          type="button"
          onClick={() => onSelect(category.slug)}
          className={cn(
            "flex items-center justify-between rounded-md px-2 py-1.5 text-sm capitalize transition-colors hover:bg-accent/40",
            active === category.slug ? "bg-accent/60 font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="truncate">{category.slug}</span>
          <span className="ml-2 shrink-0 text-xs text-muted-foreground">{category.count}</span>
        </button>
      ))}
    </nav>
  );
}

export function DiscoveryGrid({
  tab,
  tabCounts,
  onTabChange,
  categories,
  categoryTotal,
  activeCategory,
  onCategoryChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
  cards,
  onOpenCard,
  loading,
  error,
  totalCount,
  onCreate,
  onImport,
  onBrowseCatalog,
  onScan,
  scanPending,
  scanStatus,
}: {
  tab: DiscoveryTab;
  tabCounts: Record<DiscoveryTab, number>;
  onTabChange: (tab: DiscoveryTab) => void;
  categories: DiscoveryCategory[];
  categoryTotal: number;
  activeCategory: string | null;
  onCategoryChange: (slug: string | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sort: DiscoverySort;
  onSortChange: (sort: DiscoverySort) => void;
  cards: DiscoveryCard[];
  onOpenCard: (card: DiscoveryCard) => void;
  loading: boolean;
  error: string | null;
  totalCount: number;
  onCreate: () => void;
  onImport: () => void;
  onBrowseCatalog: () => void;
  onScan: () => void;
  scanPending: boolean;
  scanStatus: string | null;
}) {
  const { t } = useTranslation();
  // Source filter (github / skills.sh / local / …) lives in the grid so it
  // narrows whatever the parent already filtered by tab/category/search (PAP-10907 E).
  const [sourceBadgeFilter, setSourceBadgeFilter] = useState<string>("all");
  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const card of cards) if (card.sourceBadge) set.add(card.sourceBadge);
    return Array.from(set).sort();
  }, [cards]);
  useEffect(() => {
    if (sourceBadgeFilter !== "all" && !availableSources.includes(sourceBadgeFilter)) {
      setSourceBadgeFilter("all");
    }
  }, [availableSources, sourceBadgeFilter]);
  const sourceFilteredCards = useMemo(
    () => (sourceBadgeFilter === "all" ? cards : cards.filter((card) => card.sourceBadge === sourceBadgeFilter)),
    [cards, sourceBadgeFilter],
  );
  const sourceFilterActive = sourceBadgeFilter !== "all";

  return (
    // On desktop the store is bounded to the viewport so the category sidebar
    // and the results pane each scroll independently (PAP-10907). Mobile keeps
    // the natural page flow.
    <div className="flex min-h-[calc(100vh-12rem)] md:h-[calc(100dvh-6rem)] md:min-h-0 md:overflow-hidden">
      {/* Secondary category sidebar — the main app nav collapses to a rail while
          this is present (handled in Layout). */}
      <aside className="hidden w-60 shrink-0 flex-col overflow-hidden border-r border-border md:flex">
        <div className="border-b border-border px-4 py-4">
          <h2 className="text-sm font-semibold text-foreground">{t("pages.companySkills.skillsStoreTitle", { defaultValue: "Skills Store" })}</h2>
          <p className="text-xs text-muted-foreground">{t("pages.companySkills.skillsStoreSubtitle", { defaultValue: "Discover, install, fork, share" })}</p>
        </div>
        <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("pages.companySkills.categoriesLabel", { defaultValue: "Categories" })}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <CategoryNav
            categories={categories}
            total={categoryTotal}
            active={activeCategory}
            onSelect={onCategoryChange}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Search + sort + actions */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex h-9 min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-border px-2.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t("pages.companySkills.searchPlaceholder", { defaultValue: "Search skills, authors, categories…" })}
              className="h-full w-full bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <span className="text-muted-foreground">{t("pages.companySkills.sortLabel", { defaultValue: "Sort" })}</span>
                <span className="ml-1.5">{discoverySortLabel(sort)}</span>
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as DiscoverySort)}>
                {DISCOVERY_SORTS.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {discoverySortLabel(option)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {availableSources.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <span className="text-muted-foreground">{t("pages.companySkills.sourceLabel", { defaultValue: "Source" })}</span>
                  <span className="ml-1.5 capitalize">
                    {sourceBadgeFilter === "all" ? t("pages.companySkills.sourceFilterAll", { defaultValue: "All" }) : sourceMeta(sourceBadgeFilter as CompanySkillSourceBadge, null).label}
                  </span>
                  <ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={sourceBadgeFilter} onValueChange={setSourceBadgeFilter}>
                  <DropdownMenuRadioItem value="all">{t("pages.companySkills.allSources", { defaultValue: "All sources" })}</DropdownMenuRadioItem>
                  {availableSources.map((badge) => (
                    <DropdownMenuRadioItem key={badge} value={badge}>
                      {sourceMeta(badge as CompanySkillSourceBadge, null).label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onScan}
            disabled={scanPending}
            title={t("pages.companySkills.scanProjectsTitle", { defaultValue: "Scan project workspaces for skills" })}
          >
            <RefreshCw className={cn("h-4 w-4", scanPending && "animate-spin")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="default">
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("pages.companySkills.newButton", { defaultValue: "New" })}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onCreate}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("pages.companySkills.createNewSkill", { defaultValue: "Create new skill" })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onBrowseCatalog}>
                <Boxes className="mr-2 h-4 w-4" />
                {t("pages.companySkills.browseCatalog", { defaultValue: "Browse catalog" })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onImport}>
                <Globe className="mr-2 h-4 w-4" />
                {t("pages.companySkills.importFromPathOrUrl", { defaultValue: "Import from path or URL" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Mobile category selector (sidebar is hidden below md) */}
        {categories.length > 0 ? (
          <div className="border-b border-border px-4 py-2 md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full justify-between">
                  <span className="capitalize">{activeCategory ?? t("pages.companySkills.allCategories", { defaultValue: "All categories" })}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
                <DropdownMenuRadioGroup
                  value={activeCategory ?? "__all__"}
                  onValueChange={(value) => onCategoryChange(value === "__all__" ? null : value)}
                >
                  <DropdownMenuRadioItem value="__all__">{t("pages.companySkills.allWithCount", { count: categoryTotal, defaultValue: "All ({{count}})" })}</DropdownMenuRadioItem>
                  {categories.map((category) => (
                    <DropdownMenuRadioItem key={category.slug} value={category.slug} className="capitalize">
                      {category.slug} ({category.count})
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        {/* Tab strip — Bundled/required lives at the end */}
        <div className="border-b border-border px-4">
          <Tabs value={tab} onValueChange={(value) => onTabChange(value as DiscoveryTab)}>
            <TabsList variant="line" className="p-0">
              <TabsTrigger value="all" className="px-3">
                <span>{t("pages.companySkills.tabAll", { defaultValue: "All" })}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{tabCounts.all}</span>
              </TabsTrigger>
              <TabsTrigger value="installed" className="px-3">
                <span>{t("pages.companySkills.tabInstalled", { defaultValue: "Installed" })}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{tabCounts.installed}</span>
              </TabsTrigger>
              <TabsTrigger value="catalog" className="px-3">
                <span>{t("pages.companySkills.tabCatalog", { defaultValue: "Catalog" })}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{tabCounts.catalog}</span>
              </TabsTrigger>
              <TabsTrigger value="bundled" className="px-3">
                <span>{t("pages.companySkills.tabBundled", { defaultValue: "Bundled" })}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{tabCounts.bundled}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Grid body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {scanStatus ? <p className="mb-3 text-xs text-muted-foreground">{scanStatus}</p> : null}
          {loading ? (
            <PageSkeleton variant="list" />
          ) : error ? (
            <div className="py-6 text-sm text-destructive">{error}</div>
          ) : sourceFilteredCards.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={LayoutGrid}
                message={
                  totalCount === 0
                    ? t("pages.companySkills.emptyNoSkillsYet", { defaultValue: "No skills yet. Create one or install from the catalog." })
                    : search || activeCategory || sourceFilterActive
                      ? t("pages.companySkills.emptyNoSkillsMatch", { defaultValue: "No skills match your filters." })
                      : t("pages.companySkills.emptyNoSkillsInTab", { defaultValue: "No skills in this tab yet." })
                }
              />
              {totalCount === 0 ? (
                <div className="mt-3 flex flex-col items-center gap-2">
                  <Button size="sm" onClick={onBrowseCatalog}>
                    <Boxes className="mr-1.5 h-3.5 w-3.5" /> {t("pages.companySkills.browseCatalog", { defaultValue: "Browse catalog" })}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onCreate}>
                    {t("pages.companySkills.createASkill", { defaultValue: "Create a skill" })}
                  </Button>
                </div>
              ) : (search || activeCategory || sourceFilterActive) ? (
                <div className="mt-3 flex justify-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onSearchChange("");
                      onCategoryChange(null);
                      setSourceBadgeFilter("all");
                    }}
                  >
                    {t("pages.companySkills.clearFilters", { defaultValue: "Clear filters" })}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                {t("pages.companySkills.skillCount", { count: sourceFilteredCards.length, defaultValue: "{{count}} skills" })}
                {activeCategory ? <span className="capitalize"> · {activeCategory}</span> : null}
              </p>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
                {sourceFilteredCards.map((card) => (
                  <SkillCard key={card.key} card={card} onOpen={onOpenCard} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type SkillCreateDraft = {
  name: string;
  slug: string;
  tagline: string;
  description: string;
  color: string;
  categories: string[];
  markdown: string;
  sharingScope: Exclude<CompanySkillSharingScope, "public_link">;
  forkedFromSkillId: string | null;
  forkedFromName: string | null;
};

function buildBlankSkillDraft(): SkillCreateDraft {
  return {
    name: "",
    slug: "",
    tagline: "",
    description: "",
    color: DISCOVERY_ACCENTS[0]!,
    categories: [],
    markdown: defaultSkillMarkdown("", ""),
    sharingScope: "company",
    forkedFromSkillId: null,
    forkedFromName: null,
  };
}

function buildForkSkillDraft(skill: CompanySkillDetail): SkillCreateDraft {
  const name = `${skill.name} Fork`;
  const slug = normalizeSkillDraftSlug(`${skill.slug}-fork`);
  return {
    name,
    slug,
    tagline: skill.tagline ?? "",
    description: skill.description ?? "",
    color: skill.color ?? skillAccentColor(skill.key, null),
    categories: skill.categories,
    markdown: skill.markdown.replace(/^name:\s*.*$/m, `name: ${name}`),
    sharingScope: "company",
    forkedFromSkillId: skill.id,
    forkedFromName: skill.name,
  };
}

function NewSkillWizard({
  initialDraft,
  onCreate,
  isPending,
  error,
  onCancel,
}: {
  initialDraft: SkillCreateDraft;
  onCreate: (payload: CompanySkillCreateRequest) => void;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SkillCreateDraft>(initialDraft);
  const [slugDirty, setSlugDirty] = useState(initialDraft.slug.trim().length > 0);
  const categoryDraft = draft.categories.join(", ");
  const steps = [
    t("pages.companySkills.wizardStepBasics", { defaultValue: "Basics" }),
    t("pages.companySkills.wizardStepDesign", { defaultValue: "Design" }),
    t("pages.companySkills.wizardStepContent", { defaultValue: "Content" }),
    t("pages.companySkills.wizardStepReview", { defaultValue: "Review" }),
  ];

  useEffect(() => {
    setStep(0);
    setDraft(initialDraft);
    setSlugDirty(initialDraft.slug.trim().length > 0);
  }, [initialDraft]);

  function patchDraft(patch: Partial<SkillCreateDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const nameValid = draft.name.trim().length > 0;
  const effectiveSlug = draft.slug.trim() || normalizeSkillDraftSlug(draft.name);
  const effectiveMarkdown = draft.markdown.trim().length > 0
    ? draft.markdown
    : defaultSkillMarkdown(draft.name, draft.tagline);

  function submit() {
    onCreate({
      name: draft.name.trim(),
      slug: effectiveSlug || null,
      description: draft.description.trim() || draft.tagline.trim() || null,
      markdown: effectiveMarkdown,
      color: draft.color,
      tagline: draft.tagline.trim() || null,
      categories: draft.categories,
      sharingScope: draft.sharingScope,
      forkedFromSkillId: draft.forkedFromSkillId,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-border pb-3">
        {steps.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(index)}
            className={cn(
              "rounded-md px-2 py-1 text-xs",
              step === index ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {draft.forkedFromName ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <GitFork className="h-3.5 w-3.5" />
          {t("pages.companySkills.wizardForking", { name: draft.forkedFromName, defaultValue: "Forking {{name}}" })}
        </div>
      ) : null}

      {step === 0 ? (
        <div className="space-y-3">
          <Input
            value={draft.name}
            onChange={(event) => {
              const nextName = event.target.value;
              patchDraft({
                name: nextName,
                slug: slugDirty ? draft.slug : normalizeSkillDraftSlug(nextName),
                markdown: draft.markdown === defaultSkillMarkdown(draft.name, draft.tagline)
                  ? defaultSkillMarkdown(nextName, draft.tagline)
                  : draft.markdown,
              });
            }}
            placeholder={t("pages.companySkills.wizardSkillNamePlaceholder", { defaultValue: "Skill name" })}
            className="h-9"
          />
          <Input
            value={draft.slug}
            onChange={(event) => {
              const nextSlug = normalizeSkillDraftSlug(event.target.value);
              setSlugDirty(nextSlug.length > 0);
              patchDraft({ slug: nextSlug });
            }}
            placeholder="skill-shortname"
            className="h-9 font-mono"
          />
          <Textarea
            value={draft.tagline}
            onChange={(event) => {
              const nextTagline = event.target.value;
              patchDraft({
                tagline: nextTagline,
                description: draft.description ? draft.description : nextTagline,
                markdown: draft.markdown === defaultSkillMarkdown(draft.name, draft.tagline)
                  ? defaultSkillMarkdown(draft.name, nextTagline)
                  : draft.markdown,
              });
            }}
            placeholder={t("pages.companySkills.wizardTaglinePlaceholder", { defaultValue: "One-line promise for the skill" })}
            className="min-h-20"
          />
        </div>
      ) : step === 1 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <SkillCardIcon
              size={48}
              card={{
                key: effectiveSlug || draft.name || "new-skill",
                skillId: null,
                catalogRef: null,
                name: draft.name || t("pages.companySkills.defaultSkillTitle", { defaultValue: "New Skill" }),
                slug: effectiveSlug || "skill",
                author: "you",
                version: null,
                tagline: draft.tagline || null,
                description: draft.tagline,
                categories: draft.categories,
                iconUrl: null,
                color: draft.color,
                starCount: 0,
                agentCount: 0,
                forkCount: 0,
                installed: false,
                required: false,
                forkedFrom: Boolean(draft.forkedFromSkillId),
                updatedAt: Date.now(),
              }}
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{draft.name || t("pages.companySkills.defaultSkillTitle", { defaultValue: "New Skill" })}</div>
              <div className="truncate text-xs text-muted-foreground">{draft.tagline || t("pages.companySkills.wizardNoTagline", { defaultValue: "No tagline yet." })}</div>
            </div>
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.wizardColorLabel", { defaultValue: "Color" })}</label>
            <div className="flex flex-wrap gap-2">
              {DISCOVERY_ACCENTS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => patchDraft({ color })}
                  className={cn(
                    "h-7 w-7 rounded-md border",
                    draft.color === color ? "border-foreground" : "border-border",
                  )}
                  style={{ backgroundColor: color }}
                  aria-label={t("pages.companySkills.wizardUseColor", { color, defaultValue: "Use {{color}}" })}
                />
              ))}
              <Input
                value={draft.color}
                onChange={(event) => patchDraft({ color: event.target.value })}
                className="h-7 w-28 font-mono text-xs"
              />
            </div>
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.wizardCategoriesLabel", { defaultValue: "Categories" })}</label>
            <Input
              value={categoryDraft}
              onChange={(event) => patchDraft({ categories: splitCategoryDraft(event.target.value) })}
              placeholder={t("pages.companySkills.wizardCategoriesPlaceholder", { defaultValue: "engineering, review, memory" })}
              className="h-9"
            />
          </div>
        </div>
      ) : step === 2 ? (
        <div className="space-y-2">
          <Textarea
            value={draft.markdown}
            onChange={(event) => patchDraft({ markdown: event.target.value })}
            className="h-[clamp(14rem,45vh,28rem)] resize-y font-mono text-xs"
          />
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2">
            <span className="text-muted-foreground">{t("pages.companySkills.reviewName", { defaultValue: "Name" })}</span>
            <span>{draft.name || t("pages.companySkills.reviewUntitled", { defaultValue: "Untitled" })}</span>
            <span className="text-muted-foreground">{t("pages.companySkills.reviewSlug", { defaultValue: "Slug" })}</span>
            <span className="font-mono">{effectiveSlug || "skill"}</span>
            <span className="text-muted-foreground">{t("pages.companySkills.reviewScope", { defaultValue: "Scope" })}</span>
            <span>{draft.sharingScope === "private" ? t("pages.companySkills.scopePrivate", { defaultValue: "Private" }) : t("pages.companySkills.scopeCompany", { defaultValue: "Company" })}</span>
            <span className="text-muted-foreground">{t("pages.companySkills.reviewCategories", { defaultValue: "Categories" })}</span>
            <span>{draft.categories.length ? draft.categories.join(", ") : t("pages.companySkills.reviewNone", { defaultValue: "none" })}</span>
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.sharingLabel", { defaultValue: "Sharing" })}</label>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["company", "private"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => patchDraft({ sharingScope: scope })}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-sm",
                    draft.sharingScope === scope ? "border-foreground bg-accent/50" : "border-border",
                  )}
                >
                  <span className="block font-medium">{scope === "company" ? t("pages.companySkills.scopeCompany", { defaultValue: "Company" }) : t("pages.companySkills.scopePrivate", { defaultValue: "Private" })}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {scope === "company" ? t("pages.companySkills.scopeCompanyDescription", { defaultValue: "Visible inside this company." }) : t("pages.companySkills.scopePrivateDescription", { defaultValue: "Only visible in your library." })}
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled
                className="rounded-md border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground"
              >
                <span className="block font-medium">{t("pages.companySkills.publicLink", { defaultValue: "Public link" })}</span>
                <span className="mt-1 block text-xs">{t("pages.companySkills.comingLater", { defaultValue: "Coming later." })}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          {t("pages.companySkills.cancel", { defaultValue: "Cancel" })}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={isPending || step === 0}>
            {t("pages.companySkills.back", { defaultValue: "Back" })}
          </Button>
          {step < steps.length - 1 ? (
            <Button size="sm" onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))} disabled={!nameValid}>
              {t("pages.companySkills.next", { defaultValue: "Next" })}
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={isPending || !nameValid}>
              {isPending ? t("pages.companySkills.creating", { defaultValue: "Creating..." }) : draft.forkedFromSkillId ? t("pages.companySkills.createFork", { defaultValue: "Create fork" }) : t("pages.companySkills.createSkill", { defaultValue: "Create skill" })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CatalogList({
  skills,
  kindFilter,
  categoryFilter,
  catalogFilter,
  installedByKey,
  selectedCatalogRef,
  selectedPath,
  expandedSkillId,
  expandedDirs,
  onSelect,
  onSelectPath,
  onToggleSkill,
  onToggleDir,
}: {
  skills: CatalogSkill[];
  kindFilter: "all" | "bundled" | "optional";
  categoryFilter: string;
  catalogFilter: string;
  installedByKey: Map<string, CompanySkillListItem>;
  selectedCatalogRef: string | null;
  selectedPath: string;
  expandedSkillId: string | null;
  expandedDirs: Record<string, Set<string>>;
  onSelect: (catalogRef: string) => void;
  onSelectPath: (catalogRef: string, path: string) => void;
  onToggleSkill: (catalogRef: string) => void;
  onToggleDir: (catalogRef: string, path: string) => void;
}) {
  const { t } = useTranslation();
  const lowered = catalogFilter.trim().toLowerCase();
  const filtered = skills.filter((skill) => {
    if (kindFilter !== "all" && skill.kind !== kindFilter) return false;
    if (categoryFilter && skill.category !== categoryFilter) return false;
    if (!lowered) return true;
    const haystack = `${skill.name} ${skill.slug} ${skill.key} ${skill.description} ${skill.category} ${skill.tags.join(" ")} ${skill.recommendedForRoles.join(" ")}`.toLowerCase();
    return haystack.includes(lowered);
  });

  if (filtered.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {t("pages.companySkills.noCatalogSkillsMatch", { defaultValue: "No catalog skills match this filter." })}
      </div>
    );
  }

  const available = filtered.filter((skill) => !installedByKey.has(skill.key));
  const installed = filtered.filter((skill) => installedByKey.has(skill.key));
  const bundled = available.filter((skill) => skill.kind === "bundled");
  const optional = available.filter((skill) => skill.kind === "optional");

  function renderRow(skill: CatalogSkill) {
    const isSelected = selectedCatalogRef === skill.id || selectedCatalogRef === skill.key;
    const expanded = expandedSkillId === skill.id;
    const tree = buildTree(skill.files.map((file) => ({
      path: file.path,
      kind: file.kind,
    })));
    return (
      <div key={skill.id} className="border-b border-border">
        <div
          className={cn(
            "group grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
            isSelected && "text-foreground",
          )}
        >
          <Link
            to={catalogSkillRoute(skill.id)}
            className="flex min-w-0 items-center self-stretch pr-2 text-left no-underline"
            onClick={() => onSelect(skill.id)}
          >
            <span className="flex min-w-0 items-center gap-2 self-center">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-75 transition-opacity group-hover:opacity-100">
                <Boxes className={cn("h-3.5 w-3.5", skill.kind === "optional" && "opacity-70")} aria-hidden="true" />
              </span>
              <span className="min-w-0 overflow-hidden text-[13px] font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                {skill.name}
              </span>
            </span>
          </Link>
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
            onClick={() => onToggleSkill(skill.id)}
            aria-label={expanded ? t("pages.companySkills.collapseSkill", { name: skill.name, defaultValue: "Collapse {{name}}" }) : t("pages.companySkills.expandSkill", { name: skill.name, defaultValue: "Expand {{name}}" })}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div
          aria-hidden={!expanded}
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <SkillTree
              nodes={tree}
              skillId={skill.id}
              selectedPath={isSelected ? selectedPath : "SKILL.md"}
              expandedDirs={expandedDirs[skill.id] ?? new Set<string>()}
              onToggleDir={(path) => onToggleDir(skill.id, path)}
              onSelectPath={(path) => onSelectPath(skill.id, path)}
              fileHref={(skillId) => catalogSkillRoute(skillId)}
              depth={1}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {bundled.length > 0 && kindFilter !== "optional" ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.companySkills.sectionBundled", { defaultValue: "Bundled" })} · {bundled.length}
          </div>
          {bundled.map(renderRow)}
        </div>
      ) : null}
      {optional.length > 0 && kindFilter !== "bundled" ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.companySkills.sectionOptional", { defaultValue: "Optional" })} · {optional.length}
          </div>
          {optional.map(renderRow)}
        </div>
      ) : null}
      {installed.length > 0 ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.companySkills.sectionInstalled", { defaultValue: "Installed" })} · {installed.length}
          </div>
          {installed.map(renderRow)}
        </div>
      ) : null}
    </div>
  );
}

function CatalogDetailPane({
  skill,
  packageName,
  packageVersion,
  installedSkill,
  installedSkillId,
  fileQuery,
  selectedPath,
  onInstall,
  onUpdate,
  onOpenInstalled,
  loadingPrimaryAction,
}: {
  skill: CatalogSkill | null;
  packageName: string | null;
  packageVersion: string | null;
  installedSkill: CompanySkillListItem | null;
  installedSkillId: string | null;
  fileQuery: { data: CatalogSkillFileDetail | undefined; isLoading: boolean; error: unknown };
  selectedPath: string;
  onInstall: () => void;
  onUpdate: () => void;
  onOpenInstalled: (skillId: string) => void;
  loadingPrimaryAction: boolean;
}) {
  const { t } = useTranslation();
  if (!skill) {
    return <EmptyState icon={Boxes} message={t("pages.companySkills.selectCatalogSkill", { defaultValue: "Select a catalog skill to inspect." })} />;
  }

  const installedHash = installedSkill?.originHash ?? null;
  const hashOutOfSync = Boolean(installedSkill && installedHash && installedHash !== skill.contentHash);
  const isInstalled = Boolean(installedSkill);

  let cta: React.ReactNode;
  if (skill.compatibility === "invalid") {
    cta = (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button disabled>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t("pages.companySkills.installSkill", { defaultValue: "Install skill" })}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("pages.companySkills.installSkillInvalidTooltip", { defaultValue: "This skill cannot be installed — its content is not valid Agent Skills markdown." })}</TooltipContent>
      </Tooltip>
    );
  } else if (!isInstalled) {
    cta = (
      <Button onClick={onInstall} disabled={loadingPrimaryAction}>
        {skill.trustLevel === "scripts_executables" ? <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
        {loadingPrimaryAction ? t("pages.companySkills.preparing", { defaultValue: "Preparing..." }) : t("pages.companySkills.installSkillInOrg", { defaultValue: "Install skill in this organization" })}
      </Button>
    );
  } else if (hashOutOfSync) {
    cta = (
      <Button onClick={onUpdate} disabled={loadingPrimaryAction} className="border-amber-500/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30">
        <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
        {t("pages.companySkills.updateFromCatalog", { defaultValue: "Update from catalog" })}
      </Button>
    );
  } else {
    cta = (
      <Button variant="ghost" onClick={() => installedSkillId && onOpenInstalled(installedSkillId)}>
        <Check className="mr-1.5 h-3.5 w-3.5" />
        {t("pages.companySkills.installedOpenInLibrary", { defaultValue: "Installed · Open in library" })}
      </Button>
    );
  }

  const body = fileQuery.data?.markdown ? stripFrontmatter(fileQuery.data.content) : fileQuery.data?.content ?? "";

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-2xl font-semibold">
              <Boxes className={cn("h-5 w-5 shrink-0 text-muted-foreground", skill.kind === "optional" && "opacity-70")} aria-hidden="true" />
              {skill.name}
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{skill.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 uppercase tracking-wide">{skill.kind}</span>
              <span>·</span>
              <span>{skill.category}</span>
              <span>·</span>
              <ProvenanceBadge packageName={packageName} packageVersion={packageVersion} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">{cta}</div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <TrustChip level={skill.trustLevel} />
          <CompatChip compatibility={skill.compatibility} />
          {hashOutOfSync ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                  <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                  {t("pages.companySkills.updateAvailable", { defaultValue: "Update available" })}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("pages.companySkills.updateAvailableTooltip", { defaultValue: "Catalog content hash has changed since this skill was installed." })}</TooltipContent>
            </Tooltip>
          ) : null}
          {skill.requires.length > 0 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("pages.companySkills.requiresLabel", { values: skill.requires.join(", "), defaultValue: "Requires: {{values}}" })}
            </span>
          ) : null}
          {skill.recommendedForRoles.length > 0 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("pages.companySkills.rolesLabel", { values: skill.recommendedForRoles.join(" · "), defaultValue: "Roles: {{values}}" })}
            </span>
          ) : null}
          {skill.tags.length > 0 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("pages.companySkills.tagsLabel", { values: skill.tags.join(" · "), defaultValue: "Tags: {{values}}" })}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="uppercase tracking-[0.18em]">{t("pages.companySkills.keyLabel", { defaultValue: "Key" })}</span>
          <span className="font-mono">{skill.key}</span>
          <span className="uppercase tracking-[0.18em]">·</span>
          <span className="uppercase tracking-[0.18em]">{t("pages.companySkills.hashLabel", { defaultValue: "Hash" })}</span>
          <span className="font-mono">{skill.contentHash.slice(0, 24)}…</span>
          <CopyText
            text={skill.contentHash}
            copiedLabel={t("pages.companySkills.copiedHash", { defaultValue: "Copied hash" })}
            ariaLabel={t("pages.companySkills.copyContentHash", { defaultValue: "Copy content hash" })}
            title={t("pages.companySkills.copyContentHash", { defaultValue: "Copy content hash" })}
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </CopyText>
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <div className="truncate font-mono text-sm">{selectedPath}</div>
      </div>

      <div className="min-h-[400px] px-5 py-5">
        {fileQuery.isLoading ? (
          <PageSkeleton variant="detail" />
        ) : fileQuery.error ? (
          <div className="text-sm text-destructive">{fileQuery.error instanceof Error ? fileQuery.error.message : t("pages.companySkills.failedToLoadFile", { defaultValue: "Failed to load file" })}</div>
        ) : !fileQuery.data ? (
          <div className="text-sm text-muted-foreground">{t("pages.companySkills.selectFileToInspect", { defaultValue: "Select a file to inspect." })}</div>
        ) : fileQuery.data.markdown ? (
          <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body}</MarkdownBody>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{fileQuery.data.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

function InstallPreviewDialog({
  open,
  onOpenChange,
  skill,
  packageName,
  packageVersion,
  conflict,
  defaultSlug,
  defaultForce,
  defaultAction,
  isPending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: CatalogSkill | null;
  packageName: string | null;
  packageVersion: string | null;
  conflict: CompanySkillListItem | null;
  defaultSlug: string | null;
  defaultForce: boolean;
  defaultAction: "install" | "update" | "replace";
  isPending: boolean;
  error: string | null;
  onConfirm: (input: { slug: string | null; force: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState<string>("");
  const [force, setForce] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSlug(defaultSlug ?? "");
    setForce(defaultForce);
    setAdvancedOpen(defaultAction === "replace" || defaultForce);
  }, [open, defaultSlug, defaultForce, defaultAction]);

  if (!skill) return null;

  let confirmLabel = t("pages.companySkills.installSkill", { defaultValue: "Install skill" });
  let confirmVariant: "default" | "destructive" = "default";
  if (defaultAction === "update") {
    confirmLabel = t("pages.companySkills.installUpdate", { defaultValue: "Install update" });
  } else if (defaultAction === "replace") {
    confirmLabel = t("pages.companySkills.replaceExistingSkill", { defaultValue: "Replace existing skill" });
    confirmVariant = "destructive";
  }
  if (isPending) confirmLabel = t("pages.companySkills.installing", { defaultValue: "Installing…" });

  const titleAction = defaultAction === "update"
    ? t("pages.companySkills.installActionUpdate", { defaultValue: "Update" })
    : defaultAction === "replace"
      ? t("pages.companySkills.installActionReplace", { defaultValue: "Replace" })
      : t("pages.companySkills.installActionInstall", { defaultValue: "Install" });

  return (
    <Dialog open={open} onOpenChange={(value) => (!isPending ? onOpenChange(value) : null)}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>
            {titleAction} · {skill.name}
          </DialogTitle>
          <DialogDescription>
            <span className="capitalize">{skill.kind}</span> · {skill.category}
            {packageName ? <> · {packageName}{packageVersion ? ` v${packageVersion}` : ""}</> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-border p-3">
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-xs">
              <div className="text-muted-foreground">{t("pages.companySkills.trustLabel", { defaultValue: "Trust" })}</div>
              <div className="flex items-center gap-2">
                <TrustChip level={skill.trustLevel} />
                {skill.trustLevel === "markdown_only" ? (
                  <span className="text-muted-foreground">{t("pages.companySkills.trustSafe", { defaultValue: "Safe" })}</span>
                ) : skill.trustLevel === "scripts_executables" ? (
                  <span className="text-amber-200">{t("pages.companySkills.trustReviewRequired", { defaultValue: "Review required" })}</span>
                ) : (
                  <span className="text-muted-foreground">{t("pages.companySkills.trustNonScriptAssets", { defaultValue: "Non-script assets" })}</span>
                )}
              </div>
              <div className="text-muted-foreground">{t("pages.companySkills.compatibilityLabel", { defaultValue: "Compatibility" })}</div>
              <div className="flex items-center gap-2">
                {skill.compatibility === "compatible" ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {t("pages.companySkills.compatible", { defaultValue: "Compatible" })}
                  </span>
                ) : (
                  <CompatChip compatibility={skill.compatibility} />
                )}
              </div>
              <div className="text-muted-foreground">{t("pages.companySkills.requiresFieldLabel", { defaultValue: "Requires" })}</div>
              <div className="text-foreground">{skill.requires.length === 0 ? t("pages.companySkills.valueNone", { defaultValue: "none" }) : skill.requires.join(", ")}</div>
              <div className="text-muted-foreground">{t("pages.companySkills.rolesFieldLabel", { defaultValue: "Roles" })}</div>
              <div className="text-foreground">{skill.recommendedForRoles.length === 0 ? t("pages.companySkills.valueAny", { defaultValue: "any" }) : skill.recommendedForRoles.join(" · ")}</div>
              <div className="text-muted-foreground">{t("pages.companySkills.provenanceLabel", { defaultValue: "Provenance" })}</div>
              <div className="min-w-0">
                <div className="truncate">{packageName ?? "—"}{packageVersion ? ` v${packageVersion}` : ""}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{skill.contentHash}</div>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              {t("pages.companySkills.filesWithCount", { count: skill.files.length, defaultValue: "Files ({{count}})" })}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {skill.files.map((file) => (
                <div key={file.path} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 border-b border-border/50 px-3 py-1.5 text-xs last:border-b-0">
                  <span className="truncate font-mono text-muted-foreground">{file.path}</span>
                  <span className="rounded border border-border bg-muted/40 px-1 py-0.5 text-[10px] uppercase text-muted-foreground">{file.kind}</span>
                  <span className="text-[11px] text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                </div>
              ))}
            </div>
          </div>

          {conflict ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              {t("pages.companySkills.conflictPrefix", { defaultValue: "An existing skill with key" })} <span className="font-mono">{conflict.key}</span> {t("pages.companySkills.conflictSuffix", {
                source: conflict.sourceLabel ?? conflict.sourceType,
                action: defaultAction === "update"
                  ? t("pages.companySkills.conflictActionOverwrite", { defaultValue: "overwrite the catalog content" })
                  : t("pages.companySkills.conflictActionReplace", { defaultValue: "replace the existing skill" }),
                defaultValue: "is installed ({{source}}). Installing will {{action}}.",
              })}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {t("pages.companySkills.advanced", { defaultValue: "Advanced" })}
          </button>
          {advancedOpen ? (
            <div className="space-y-3 rounded-md border border-border p-3 text-xs">
              <div>
                <label className="mb-1 block uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.slugOverride", { defaultValue: "Slug override" })}</label>
                <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={defaultSlug ?? skill.slug} className="h-8" />
              </div>
              <label className="flex items-center gap-2">
                <Checkbox checked={force} onCheckedChange={(value) => setForce(Boolean(value))} />
                <span>{t("pages.companySkills.forceReplace", { defaultValue: "Force replace existing same-key skill" })}</span>
              </label>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t("pages.companySkills.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => onConfirm({ slug: slug.trim().length > 0 ? slug.trim() : null, force })}
            disabled={isPending}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type AttachAgentOption = {
  id: string;
  name: string;
  adapterType: string;
  supportsSkills: boolean;
  required: boolean;
  icon: string | null;
  paused: boolean;
};

function AttachAgentsPopover({
  agents,
  attachedAgentIds,
  versions,
  selectedVersionId,
  pending,
  onSubmit,
  fullWidth = false,
}: {
  agents: AttachAgentOption[];
  attachedAgentIds: string[];
  versions: CompanySkillVersion[];
  selectedVersionId: string | null;
  pending: boolean;
  onSubmit: (nextIds: string[], versionId: string | null) => void;
  fullWidth?: boolean;
}) {
  const { t } = useTranslation();
  // Each popover instance owns its open state. The detail page renders two of
  // these (agents tab + sidebar); sharing a single controlled flag made both
  // open at once and swallowed clicks, so "Add to agent" appeared dead (PAP-10907 H).
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(attachedAgentIds));
  const [draftVersionId, setDraftVersionId] = useState<string | null>(selectedVersionId);

  useEffect(() => {
    if (open) {
      setDraft(new Set(attachedAgentIds));
      setDraftVersionId(selectedVersionId);
      setFilter("");
    }
  }, [open, attachedAgentIds, selectedVersionId]);

  // Checked agents float to the top of the list (PAP-10907); within each group
  // we keep a stable alphabetical order.
  const filtered = agents
    .filter((agent) => agent.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      const aChecked = draft.has(a.id);
      const bChecked = draft.has(b.id);
      if (aChecked !== bChecked) return aChecked ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const eligible = agents.filter((agent) => agent.supportsSkills);
  const sortedVersions = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className={cn(fullWidth && "w-full")}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("pages.companySkills.addToAgent", { defaultValue: "Add to agent" })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="border-b border-border px-3 py-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("pages.companySkills.filterAgents", { defaultValue: "Filter agents" })}
            className="h-8"
          />
          {sortedVersions.length > 0 ? (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="shrink-0 text-muted-foreground">{t("pages.companySkills.versionLabel", { defaultValue: "Version" })}</span>
              <select
                value={draftVersionId ?? "__latest__"}
                onChange={(event) => setDraftVersionId(event.target.value === "__latest__" ? null : event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                <option value="__latest__">{t("pages.companySkills.latest", { defaultValue: "Latest" })}</option>
                {sortedVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.revisionNumber}{version.label ? ` · ${version.label}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        {eligible.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {t("pages.companySkills.noAgentsSupportSkills", { defaultValue: "No agents in this company support skills yet." })}
          </div>
        ) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.map((agent) => {
              const disabled = agent.required || !agent.supportsSkills;
              const checked = draft.has(agent.id);
              return (
                <label
                  key={agent.id}
                  className={cn(
                    "flex items-start gap-2 px-3 py-1.5 text-sm hover:bg-accent/30",
                    disabled && "opacity-60",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(value) => {
                      setDraft((current) => {
                        const next = new Set(current);
                        if (value) next.add(agent.id);
                        else next.delete(agent.id);
                        return next;
                      });
                    }}
                  />
                  <AgentIcon icon={agent.icon} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{agent.name}</span>
                      {agent.paused ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-500">
                          <Pause className="h-2.5 w-2.5" aria-hidden="true" />
                          {t("pages.companySkills.paused", { defaultValue: "Paused" })}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {agent.adapterType}
                      {agent.required ? t("pages.companySkills.agentRequiredSuffix", { defaultValue: " · required" }) : ""}
                      {!agent.supportsSkills ? t("pages.companySkills.agentSkillsNotSupportedSuffix", { defaultValue: " · skills not supported" }) : ""}
                    </span>
                  </span>
                </label>
              );
            })}
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">{t("pages.companySkills.noMatches", { defaultValue: "No matches." })}</div>
            ) : null}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            {t("pages.companySkills.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSubmit(Array.from(draft), draftVersionId);
              setOpen(false);
            }}
            disabled={pending}
          >
            {pending ? t("pages.companySkills.savingEllipsis", { defaultValue: "Saving…" }) : t("pages.companySkills.save", { defaultValue: "Save" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SkillTree({
  nodes,
  skillId,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  fileHref = (currentSkillId, path) => skillRoute(currentSkillId, path),
  depth = 0,
}: {
  nodes: SkillTreeNode[];
  skillId: string;
  selectedPath: string;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
  fileHref?: (skillId: string, path?: string | null) => string;
  depth?: number;
}) {
  return (
    <div>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && node.path ? expandedDirs.has(node.path) : false;
        if (node.kind === "dir") {
          return (
            <div key={node.path ?? node.name}>
              <div
                className={cn(
                  "group grid w-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  SKILL_TREE_ROW_HEIGHT_CLASS,
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 py-1 text-left"
                  style={{ paddingLeft: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {expanded ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
                  </span>
                  <span className="truncate">{node.name}</span>
                </button>
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              </div>
              {expanded && (
                <SkillTree
                  nodes={node.children}
                  skillId={skillId}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  onSelectPath={onSelectPath}
                  fileHref={fileHref}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        const FileIcon = fileIcon(node.fileKind ?? "other");
        return (
          <Link
            key={node.path ?? node.name}
            className={cn(
              "flex w-full items-center gap-2 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              SKILL_TREE_ROW_HEIGHT_CLASS,
              node.path === selectedPath && "text-foreground",
            )}
            style={{ paddingInlineStart: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
            to={fileHref(skillId, node.path)}
            onClick={() => node.path && onSelectPath(node.path)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <FileIcon className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{node.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

function SkillList({
  skills,
  selectedSkillId,
  skillFilter,
  sourceFilter,
  expandedSkillId,
  expandedDirs,
  selectedPaths,
  onToggleSkill,
  onToggleDir,
  onSelectSkill,
  onSelectPath,
  onClearFilters,
}: {
  skills: CompanySkillListItem[];
  selectedSkillId: string | null;
  skillFilter: string;
  sourceFilter: SourceFilter;
  expandedSkillId: string | null;
  expandedDirs: Record<string, Set<string>>;
  selectedPaths: Record<string, string>;
  onToggleSkill: (skillId: string) => void;
  onToggleDir: (skillId: string, path: string) => void;
  onSelectSkill: (skillId: string) => void;
  onSelectPath: (skillId: string, path: string) => void;
  onClearFilters: () => void;
}) {
  const { t } = useTranslation();
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    if (!haystack.includes(skillFilter.toLowerCase())) return false;
    if (sourceFilter === "all") return true;
    const skillSource = classifySource(skill);
    return skillSource === sourceFilter;
  });

  if (filteredSkills.length === 0) {
    if (sourceFilter !== "all" && skills.length > 0) {
      return (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {t("pages.companySkills.noFilteredSkillsInstalled", { filter: sourceFilterLabel(sourceFilter).toLowerCase(), defaultValue: "No {{filter}} skills installed." })}{" "}
          <button type="button" className="text-foreground underline" onClick={onClearFilters}>
            {t("pages.companySkills.clearFilter", { defaultValue: "Clear filter" })}
          </button>
        </div>
      );
    }
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {t("pages.companySkills.noSkillsMatchFilter", { defaultValue: "No skills match this filter." })}
      </div>
    );
  }

  return (
    <div>
      {filteredSkills.map((skill) => {
        const expanded = expandedSkillId === skill.id;
        const tree = buildTree(skill.fileInventory);
        const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
        const SourceIcon = source.icon;

        return (
          <div key={skill.id} className="border-b border-border">
            <div
              className={cn(
                "group grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
                skill.id === selectedSkillId && "text-foreground",
              )}
            >
              <Link
                to={skillRoute(skill, skills)}
                className="flex min-w-0 items-center self-stretch pr-2 text-left no-underline"
                onClick={() => onSelectSkill(skill.id)}
              >
                <span className="flex min-w-0 items-center gap-2 self-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-75 transition-opacity group-hover:opacity-100">
                        <SourceIcon className="h-3.5 w-3.5" />
                        <span className="sr-only">{source.managedLabel}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{source.managedLabel}</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 overflow-hidden text-[13px] font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                    {skill.name}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                onClick={() => onToggleSkill(skill.id)}
                aria-label={expanded ? t("pages.companySkills.collapseSkill", { name: skill.name, defaultValue: "Collapse {{name}}" }) : t("pages.companySkills.expandSkill", { name: skill.name, defaultValue: "Expand {{name}}" })}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div
              aria-hidden={!expanded}
              className={cn(
                "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <SkillTree
                  nodes={tree}
                  skillId={skill.id}
                  selectedPath={selectedPaths[skill.id] ?? "SKILL.md"}
                  expandedDirs={expandedDirs[skill.id] ?? new Set<string>()}
                  onToggleDir={(path) => onToggleDir(skill.id, path)}
                  onSelectPath={(path) => onSelectPath(skill.id, path)}
                  fileHref={(_, path) => skillRoute(skill, skills, path)}
                  depth={1}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type SkillDetailTab = "overview" | "files" | "versions" | "agents";

const SKILL_DETAIL_TABS: Array<{ value: SkillDetailTab; labelKey: string; labelDefault: string; icon: typeof FileText }> = [
  { value: "overview", labelKey: "pages.companySkills.detailTabOverview", labelDefault: "Overview", icon: FileText },
  { value: "files", labelKey: "pages.companySkills.detailTabFiles", labelDefault: "Files", icon: FolderOpen },
  { value: "versions", labelKey: "pages.companySkills.detailTabVersions", labelDefault: "Versions", icon: History },
  { value: "agents", labelKey: "pages.companySkills.detailTabAgents", labelDefault: "Agents", icon: Users },
];

function currentVersionSelection(detail: CompanySkillDetail | null | undefined) {
  const selected = detail?.usedByAgents.find((agent) => agent.versionId)?.versionId;
  return selected ?? null;
}

function versionLabel(version: CompanySkillVersion | null | undefined) {
  if (!version) return t("pages.companySkills.latest", { defaultValue: "Latest" });
  return `v${version.revisionNumber}${version.label ? ` · ${version.label}` : ""}`;
}

export function getSkillVersionDiffSelection(versions: CompanySkillVersion[], targetVersionId?: string | null) {
  const sorted = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const right = targetVersionId
    ? sorted.find((version) => version.id === targetVersionId) ?? null
    : sorted[0] ?? null;
  if (!right) return { leftVersionId: null, rightVersionId: null };

  const left = sorted.find((version) => version.revisionNumber < right.revisionNumber) ?? null;
  return {
    leftVersionId: left?.id ?? null,
    rightVersionId: right.id,
  };
}

function SkillVersionDiffDialog({
  open,
  onOpenChange,
  versions,
  leftVersionId,
  rightVersionId,
  onLeftVersionChange,
  onRightVersionChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: CompanySkillVersion[];
  leftVersionId: string | null;
  rightVersionId: string | null;
  onLeftVersionChange: (id: string | null) => void;
  onRightVersionChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const sorted = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const left = sorted.find((version) => version.id === leftVersionId) ?? null;
  const right = sorted.find((version) => version.id === rightVersionId) ?? null;
  const allPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const file of left?.fileInventory ?? []) paths.add(file.path);
    for (const file of right?.fileInventory ?? []) paths.add(file.path);
    return Array.from(paths).sort((a, b) => {
      if (a === "SKILL.md") return -1;
      if (b === "SKILL.md") return 1;
      return a.localeCompare(b);
    });
  }, [left, right]);
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const effectivePath = allPaths.includes(selectedPath) ? selectedPath : allPaths[0] ?? "SKILL.md";
  const leftFile = left?.fileInventory.find((file) => file.path === effectivePath);
  const rightFile = right?.fileInventory.find((file) => file.path === effectivePath);
  const diffRows = useMemo(
    () => buildLineDiff(leftFile?.content ?? "", rightFile?.content ?? ""),
    [leftFile?.content, rightFile?.content],
  );
  const lineClassesByKind: Record<DiffRow["kind"], string> = {
    context: "bg-transparent",
    removed: "bg-red-500/10 text-red-100",
    added: "bg-green-500/10 text-green-100",
  };
  const markerByKind: Record<DiffRow["kind"], string> = {
    context: " ",
    removed: "-",
    added: "+",
  };

  useEffect(() => {
    if (open && allPaths.length > 0 && !allPaths.includes(selectedPath)) {
      setSelectedPath(allPaths[0]!);
    }
  }, [allPaths, open, selectedPath]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full !max-w-[90%] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("pages.companySkills.diffSkillFiles", { defaultValue: "Diff · skill files" })}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 font-medium uppercase tracking-wider text-red-400">{t("pages.companySkills.diffOld", { defaultValue: "Old" })}</span>
              <select
                value={leftVersionId ?? ""}
                onChange={(event) => onLeftVersionChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="">{t("pages.companySkills.diffInitial", { defaultValue: "Initial" })}</option>
                {sorted.map((version) => (
                  <option key={version.id} value={version.id}>{versionLabel(version)}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 font-medium uppercase tracking-wider text-green-400">{t("pages.companySkills.diffNew", { defaultValue: "New" })}</span>
              <select
                value={right?.id ?? ""}
                onChange={(event) => onRightVersionChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                {sorted.map((version) => (
                  <option key={version.id} value={version.id}>{versionLabel(version)}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          <aside className="hidden w-56 shrink-0 overflow-auto border-r border-border pr-3 md:block">
            {allPaths.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => setSelectedPath(path)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  effectivePath === path && "bg-accent/50 text-foreground",
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{path}</span>
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1 overflow-auto rounded-md border border-border text-xs">
            {!right ? (
              <div className="p-6 text-center text-sm text-muted-foreground">{t("pages.companySkills.diffSelectVersion", { defaultValue: "Select a version to compare." })}</div>
            ) : left?.id === right.id ? (
              <div className="p-6 text-center text-sm text-muted-foreground">{t("pages.companySkills.diffSameVersion", { defaultValue: "Both sides are the same version." })}</div>
            ) : (
              <div className="font-mono text-[12px] leading-6">
                <div className="grid grid-cols-[56px_56px_24px_minmax(0,1fr)] border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <span>{t("pages.companySkills.diffOld", { defaultValue: "Old" })}</span>
                  <span>{t("pages.companySkills.diffNew", { defaultValue: "New" })}</span>
                  <span />
                  <span>{effectivePath}</span>
                </div>
                {diffRows.map((row, index) => (
                  <div
                    key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                    className={cn("grid grid-cols-[56px_56px_24px_minmax(0,1fr)] gap-0 border-b border-border/30 px-3", lineClassesByKind[row.kind])}
                  >
                    <span className="select-none border-r border-border/30 pr-3 text-right text-muted-foreground">{row.oldLineNumber ?? ""}</span>
                    <span className="select-none border-r border-border/30 px-3 text-right text-muted-foreground">{row.newLineNumber ?? ""}</span>
                    <span className="select-none px-3 text-center text-muted-foreground">{markerByKind[row.kind]}</span>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-0 text-inherit">{row.text.length > 0 ? row.text : " "}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SkillDetailPage({
  detail,
  catalogSource,
  routeSkills,
  loading,
  activeTab,
  onTabChange,
  selectedPath,
  file,
  fileLoading,
  viewMode,
  editMode,
  draft,
  setViewMode,
  setEditMode,
  setDraft,
  onSave,
  savePending,
  versions,
  versionsLoading,
  attachAgents,
  onSubmitAttach,
  attachPending,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  updateStatus,
  updateStatusLoading,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onToggleStar,
  starPending,
  onFork,
  onUpdateSharingScope,
  updateSharingPending,
  onDelete,
  deletePending,
}: {
  detail: CompanySkillDetail | null | undefined;
  catalogSource?: CatalogSkillSource | null;
  routeSkills?: CompanySkillRouteSubject[];
  loading: boolean;
  activeTab: SkillDetailTab;
  onTabChange: (tab: SkillDetailTab) => void;
  selectedPath: string;
  file: CompanySkillFileDetail | null | undefined;
  fileLoading: boolean;
  viewMode: "preview" | "code";
  editMode: boolean;
  draft: string;
  setViewMode: (mode: "preview" | "code") => void;
  setEditMode: (value: boolean) => void;
  setDraft: (value: string) => void;
  onSave: () => void;
  savePending: boolean;
  versions: CompanySkillVersion[];
  versionsLoading: boolean;
  attachAgents: AttachAgentOption[];
  onSubmitAttach: (ids: string[], versionId: string | null) => void;
  attachPending: boolean;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onToggleStar: () => void;
  starPending: boolean;
  onFork: () => void;
  onUpdateSharingScope: (scope: Exclude<CompanySkillSharingScope, "public_link">) => void;
  updateSharingPending: boolean;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const { t } = useTranslation();
  const [diffOpen, setDiffOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Top-level description is clamped to four lines; "View all" expands it. We
  // only surface the toggle when the text actually overflows the clamp.
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el || descExpanded) return;
    setDescClamped(el.scrollHeight - el.clientHeight > 1);
  }, [detail?.description, detail?.tagline, detail?.id, descExpanded]);
  useEffect(() => {
    setDescExpanded(false);
  }, [detail?.id]);
  const sortedVersions = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const [leftVersionId, setLeftVersionId] = useState<string | null>(null);
  const [rightVersionId, setRightVersionId] = useState<string | null>(null);

  function openVersionDiff(targetVersionId?: string | null) {
    const selection = getSkillVersionDiffSelection(sortedVersions, targetVersionId);
    setLeftVersionId(selection.leftVersionId);
    setRightVersionId(selection.rightVersionId);
    setDiffOpen(Boolean(selection.rightVersionId));
  }

  // Track unsaved edits so we can float a save bar and warn before the page is
  // unloaded with a dirty draft (PAP-10907 J).
  const savedFileContent = file?.content ?? "";
  const isDirty = editMode && Boolean(file?.editable) && draft !== savedFileContent;
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  if (!detail) {
    return loading ? <PageSkeleton variant="detail" /> : <EmptyState icon={Boxes} message={t("pages.companySkills.skillNotFound", { defaultValue: "Skill not found." })} />;
  }

  const skill = detail;
  const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
  const SourceIcon = source.icon;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(skill.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const selectedVersion = versions.find((version) => version.id === currentVersionSelection(skill)) ?? null;
  const subtitleText = resolveSkillSummaryText(skill) ?? source.label;
  // Look up the richer agent record (icon, paused) for agents using this skill.
  const attachAgentMetaById = new Map(attachAgents.map((agent) => [agent.id, agent]));

  // Sidebar provenance: prefer the rich upstream attribution from the catalog
  // entry (GitHub owner/repo/path with a real link). Catalog-installed skills
  // only persist a local staging path, so without this they'd show a long,
  // unhelpful filesystem path (PAP-10907).
  const githubSource = catalogSource && catalogSource.type === "github" ? catalogSource : null;
  const githubLabel = githubSource
    ? githubSource.hostname === "github.com"
      ? "GitHub"
      : githubSource.hostname
    : null;
  const githubRepoText = githubSource
    ? `${githubSource.owner}/${githubSource.repo}${githubSource.path ? `/${githubSource.path}` : ""}`
    : null;
  const githubHref = githubSource
    ? githubSource.url
      ?? `https://${githubSource.hostname}/${githubSource.owner}/${githubSource.repo}/tree/${githubSource.ref}/${githubSource.path}`.replace(/\/$/, "")
    : null;
  // Fallback for non-catalog skills: the recorded locator/path, middle-truncated
  // so long file paths stay readable in the narrow sidebar.
  const sourceLocatorText = skill.sourcePath || skill.sourceLocator || null;
  const sourceLocatorDisplay = sourceLocatorText ? middleTruncate(sourceLocatorText, 44) : null;
  const sourceHref =
    skill.homepageUrl
    ?? (sourceLocatorText && /^(https?:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(sourceLocatorText)
      ? sourceLocatorText.startsWith("http")
        ? sourceLocatorText
        : `https://${sourceLocatorText}`
      : null);

  function renderFilesBody() {
    return (
      <div className="grid min-h-[560px] gap-0 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="border-b border-border pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.filesLabel", { defaultValue: "Files" })}</div>
          <SkillTree
            nodes={buildTree(skill.fileInventory)}
            skillId={skill.id}
            selectedPath={selectedPath}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onSelectPath={onSelectPath}
            fileHref={(_, path) => skillRoute(skill, routeSkills ?? [skill], path)}
          />
        </aside>
        <section className="min-w-0 lg:pl-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0 truncate font-mono text-sm">{file?.path ?? selectedPath}</div>
            <div className="flex items-center gap-2">
              {file?.markdown && !editMode ? (
                <div className="flex items-center border border-border">
                  <button
                    className={cn("px-3 py-1.5 text-sm", viewMode === "preview" ? "text-foreground" : "text-muted-foreground")}
                    onClick={() => setViewMode("preview")}
                  >
                    <span className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" /> {t("pages.companySkills.viewTab", { defaultValue: "View" })}</span>
                  </button>
                  <button
                    className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" ? "text-foreground" : "text-muted-foreground")}
                    onClick={() => setViewMode("code")}
                  >
                    <span className="flex items-center gap-1.5"><Code2 className="h-3.5 w-3.5" /> {t("pages.companySkills.codeTab", { defaultValue: "Code" })}</span>
                  </button>
                </div>
              ) : null}
              {skill.editable && file?.editable ? (
                editMode ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>{t("pages.companySkills.cancel", { defaultValue: "Cancel" })}</Button>
                    <Button size="sm" onClick={onSave} disabled={savePending}>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      {savePending ? t("pages.companySkills.saving", { defaultValue: "Saving..." }) : t("pages.companySkills.save", { defaultValue: "Save" })}
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setEditMode(true)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t("pages.companySkills.edit", { defaultValue: "Edit" })}
                  </Button>
                )
              ) : null}
            </div>
          </div>
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : !file ? (
            <div className="text-sm text-muted-foreground">{t("pages.companySkills.selectFileToInspect", { defaultValue: "Select a file to inspect." })}</div>
          ) : editMode && file.editable ? (
            file.markdown ? (
              <MarkdownEditor value={draft} onChange={setDraft} bordered={false} className="min-h-[520px]" />
            ) : (
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
              />
            )
          ) : file.markdown && viewMode === "preview" ? (
            <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body}</MarkdownBody>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word border-0 bg-transparent p-0 font-mono text-sm text-foreground">
              <code>{file.content}</code>
            </pre>
          )}
        </section>
      </div>
    );
  }

  function renderOverviewBody() {
    return (
      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-sm font-medium">{t("pages.companySkills.aboutHeading", { defaultValue: "About" })}</h2>
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : file?.markdown ? (
            <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body || skill.description || t("pages.companySkills.noOverviewYet", { defaultValue: "No overview yet." })}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">{skill.description ?? t("pages.companySkills.noOverviewYet", { defaultValue: "No overview yet." })}</p>
          )}
        </section>
        <section className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("pages.companySkills.keyLabel", { defaultValue: "Key" })}</div>
            <div className="mt-1 truncate font-mono">{skill.key}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("pages.companySkills.sourceLabel", { defaultValue: "Source" })}</div>
            <div className="mt-1 truncate">{skill.sourcePath ?? source.label}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("pages.companySkills.versionLabel", { defaultValue: "Version" })}</div>
            <div className="mt-1">{versionLabel(skill.currentVersion ?? null)}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("pages.companySkills.modeLabel", { defaultValue: "Mode" })}</div>
            <div className="mt-1">{skill.editable ? t("pages.companySkills.modeEditable", { defaultValue: "Editable" }) : skill.editableReason ?? t("pages.companySkills.modeReadOnly", { defaultValue: "Read only" })}</div>
          </div>
        </section>
      </div>
    );
  }

  function renderVersionsBody() {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            {versionsLoading ? t("pages.companySkills.loadingVersions", { defaultValue: "Loading versions..." }) : t("pages.companySkills.versionCount", { count: versions.length, defaultValue: "{{count}} versions" })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openVersionDiff()}
            disabled={sortedVersions.length < 2}
          >
            <History className="mr-1.5 h-3.5 w-3.5" /> {t("pages.companySkills.compare", { defaultValue: "Compare" })}
          </Button>
        </div>
        <div className="border-y border-border">
          {versionsLoading ? (
            <PageSkeleton variant="list" />
          ) : sortedVersions.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">{t("pages.companySkills.noSavedVersions", { defaultValue: "No saved versions yet." })}</div>
          ) : (
            sortedVersions.map((version) => (
              <div key={version.id} className="grid gap-2 border-b border-border px-0 py-3 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="font-medium">{versionLabel(version)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {relativeTime(version.createdAt)} · {t("pages.companySkills.filesCount", { count: version.fileInventory.length, defaultValue: "{{count}} files" })}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openVersionDiff(version.id)}
                >
                  {t("pages.companySkills.viewDiff", { defaultValue: "View diff" })}
                </Button>
              </div>
            ))
          )}
        </div>
        <SkillVersionDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          versions={sortedVersions}
          leftVersionId={leftVersionId}
          rightVersionId={rightVersionId}
          onLeftVersionChange={setLeftVersionId}
          onRightVersionChange={setRightVersionId}
        />
      </div>
    );
  }

  function renderAgentsBody() {
    // Only the agents actually using this skill are listed (PAP-10907); the
    // multi-selector behind "Add to agent" is where you attach more.
    const attached = skill.usedByAgents;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("pages.companySkills.agentsAttached", { count: attached.length, defaultValue: "{{count}} agents attached" })}
            {selectedVersion ? ` · ${versionLabel(selectedVersion)}` : ` · ${t("pages.companySkills.latest", { defaultValue: "Latest" })}`}
          </p>
          <AttachAgentsPopover
            agents={attachAgents}
            attachedAgentIds={attached.map((agent) => agent.id)}
            versions={versions}
            selectedVersionId={currentVersionSelection(skill)}
            pending={attachPending}
            onSubmit={onSubmitAttach}
          />
        </div>
        {attached.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            {t("pages.companySkills.noAgentsUsingSkill", { defaultValue: "No agents are using this skill yet. Use “Add to agent” to attach it." })}
          </div>
        ) : (
          <div className="border-y border-border">
            {attached.map((agent) => {
              const meta = attachAgentMetaById.get(agent.id);
              return (
                <div key={agent.id} className="flex items-center gap-3 border-b border-border py-3 text-sm last:border-b-0">
                  <AgentIcon icon={meta?.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{agent.name}</span>
                      {meta?.paused ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-500">
                          <Pause className="h-2.5 w-2.5" aria-hidden="true" />
                          {t("pages.companySkills.paused", { defaultValue: "Paused" })}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{agent.adapterType}</div>
                  </div>
                  <Link
                    to={`/agents/${agent.urlKey}/skills`}
                    className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground"
                  >
                    {t("pages.companySkills.view", { defaultValue: "View" })}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const tabBody = activeTab === "files"
    ? renderFilesBody()
    : activeTab === "versions"
      ? renderVersionsBody()
      : activeTab === "agents"
        ? renderAgentsBody()
        : renderOverviewBody();

  return (
    <div className="min-h-[calc(100vh-12rem)]">
      <div className="border-b border-border px-4 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-start gap-3">
              <SkillCardIcon
                card={{
                  key: detail.key,
                  skillId: detail.id,
                  catalogRef: null,
                  name: detail.name,
                  slug: detail.slug,
                  author: detail.authorName ?? source.label,
                  version: null,
                  tagline: detail.tagline,
                  description: detail.description,
                  categories: detail.categories,
                  iconUrl: detail.iconUrl,
                  color: detail.color,
                  starCount: detail.starCount,
                  agentCount: detail.attachedAgentCount,
                  forkCount: detail.forkCount,
                  installed: true,
                  required: false,
                  forkedFrom: Boolean(detail.forkedFromSkillId),
                  updatedAt: new Date(detail.updatedAt).getTime() || 0,
                }}
                size={44}
              />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate text-2xl font-semibold">{detail.name}</h1>
                  {/* Source icon sits right after the title; the tooltip names
                      where the skill was installed from (PAP-10907). */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={t("pages.companySkills.installedFrom", { source: source.label, defaultValue: "Installed from {{source}}" })}
                      >
                        <SourceIcon className="h-4 w-4" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t("pages.companySkills.installedFrom", { source: source.label, defaultValue: "Installed from {{source}}" })}</TooltipContent>
                  </Tooltip>
                </div>
                {/* GitHub-style "by" attribution sits directly under the title. */}
                {detail.authorName ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {t("pages.companySkills.byPrefix", { defaultValue: "by" })} <span className="text-foreground">{detail.authorName}</span>
                  </p>
                ) : null}
                {subtitleText ? (
                  <div className="mt-1 max-w-2xl">
                    <p
                      ref={descriptionRef}
                      className={cn(
                        "text-sm text-muted-foreground",
                        !descExpanded && "line-clamp-4",
                      )}
                    >
                      {subtitleText}
                    </p>
                    {descClamped ? (
                      <button
                        type="button"
                        onClick={() => setDescExpanded((value) => !value)}
                        className="mt-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {descExpanded ? t("pages.companySkills.showLess", { defaultValue: "Show less" }) : t("pages.companySkills.viewAll", { defaultValue: "View all" })}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {detail.categories.slice(0, 4).map((category) => (
                <SkillCategoryChip key={category} label={category} />
              ))}
            </div>
          </div>
          {/* GitHub-style social proof, top-right: installs · stars · fork.
              "Installs" counts agents that currently have this skill attached
              (PAP-10907); stars and fork are interactive. */}
          <div className="flex flex-wrap items-center justify-end gap-1">
            <div className="flex items-center overflow-hidden rounded-md border border-border">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="font-medium text-foreground">{detail.attachedAgentCount}</span>
                    <span className="hidden sm:inline">{detail.attachedAgentCount === 1 ? t("pages.companySkills.installSingular", { defaultValue: "install" }) : t("pages.companySkills.installPlural", { defaultValue: "installs" })}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("pages.companySkills.installsTooltip", { defaultValue: "Agents in this company that currently have this skill installed." })}</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={onToggleStar}
                disabled={starPending}
                className="inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
                title={detail.starredByCurrentActor ? t("pages.companySkills.unstarThisSkill", { defaultValue: "Unstar this skill" }) : t("pages.companySkills.starThisSkill", { defaultValue: "Star this skill" })}
              >
                <Star className={cn("h-3.5 w-3.5", detail.starredByCurrentActor && "fill-current text-yellow-400")} />
                <span className="hidden sm:inline">{detail.starredByCurrentActor ? t("pages.companySkills.starred", { defaultValue: "Starred" }) : t("pages.companySkills.star", { defaultValue: "Star" })}</span>
                <span className="font-medium text-foreground">{detail.starCount}</span>
              </button>
              <button
                type="button"
                onClick={onFork}
                className="inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                title={t("pages.companySkills.forkThisSkill", { defaultValue: "Fork this skill" })}
              >
                <GitFork className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("pages.companySkills.fork", { defaultValue: "Fork" })}</span>
                <span className="font-medium text-foreground">{detail.forkCount}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="min-w-0">
          <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as SkillDetailTab)}>
            {/* Underlined tab strip: the bottom padding keeps the active-tab
                underline inside the horizontal-scroll clip box (PAP-10907). */}
            <TabsList variant="line" className="mb-5 w-full max-w-full justify-start overflow-x-auto border-b border-border p-0 pb-1.5 [scrollbar-width:none]">
              {SKILL_DETAIL_TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.value} value={tab.value} className="px-3">
                    <Icon className="mr-1.5 h-3.5 w-3.5" />
                    {t(tab.labelKey, { defaultValue: tab.labelDefault })}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          {tabBody}
        </main>

        <aside className="min-w-0 space-y-6 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.agentsLabel", { defaultValue: "Agents" })}</div>
            <div className="space-y-3">
              {/* Big primary action opens the agent multi-selector (PAP-10907). */}
              <AttachAgentsPopover
                agents={attachAgents}
                attachedAgentIds={detail.usedByAgents.map((agent) => agent.id)}
                versions={versions}
                selectedVersionId={currentVersionSelection(detail)}
                pending={attachPending}
                onSubmit={onSubmitAttach}
                fullWidth
              />
              {detail.usedByAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("pages.companySkills.noAgentsAttachedYet", { defaultValue: "No agents attached yet." })}</p>
              ) : (
                <div className="space-y-0.5">
                  {/* Preview up to three attached agents, then summarise the rest. */}
                  {detail.usedByAgents.slice(0, 3).map((agent) => {
                    const meta = attachAgentMetaById.get(agent.id);
                    return (
                      <Link
                        key={agent.id}
                        to={`/agents/${agent.urlKey}/skills`}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm no-underline hover:bg-accent/40"
                      >
                        <AgentIcon icon={meta?.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
                        {meta?.paused ? (
                          <Pause className="h-3 w-3 shrink-0 text-amber-500" aria-label={t("pages.companySkills.paused", { defaultValue: "Paused" })} />
                        ) : null}
                      </Link>
                    );
                  })}
                  {detail.usedByAgents.length > 3 ? (
                    <p className="px-1.5 pt-0.5 text-xs text-muted-foreground">
                      {t("pages.companySkills.andMore", { count: detail.usedByAgents.length - 3, defaultValue: "and {{count}} more" })}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          {/* Provenance: where this skill came from, with org/path linked when
              available. Bundled/catalog skills surface their source label too
              (PAP-10907). */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.sourceLabel", { defaultValue: "Source" })}</div>
            {githubSource ? (
              <div className="flex items-start gap-2 text-sm">
                <Github className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-foreground">{githubLabel}</div>
                  <a
                    href={githubHref ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    title={githubRepoText ?? undefined}
                    className="mt-0.5 flex max-w-full items-center gap-1 text-xs text-muted-foreground no-underline transition-colors hover:text-foreground"
                  >
                    <span className="truncate">{githubRepoText}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </a>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={githubSource.commit}>
                    {githubSource.ref}
                    {githubSource.commit ? ` · ${githubSource.commit.slice(0, 7)}` : ""}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm">
                <SourceIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-foreground">{source.label}</div>
                  {sourceLocatorDisplay ? (
                    sourceHref ? (
                      <a
                        href={sourceHref}
                        target="_blank"
                        rel="noreferrer"
                        title={sourceLocatorText ?? undefined}
                        className="mt-0.5 flex max-w-full items-center gap-1 text-xs text-muted-foreground no-underline transition-colors hover:text-foreground"
                      >
                        <span className="truncate">{sourceLocatorDisplay}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={sourceLocatorText ?? undefined}>
                        {sourceLocatorDisplay}
                      </div>
                    )
                  ) : (
                    <div className="mt-0.5 text-xs text-muted-foreground">{source.managedLabel}</div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Revision / update controls sit under Agents, above the config gear
              (PAP-10907 F). Only GitHub-sourced skills can pull updates. */}
          {detail.sourceType === "github" ? (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.updatesLabel", { defaultValue: "Updates" })}</div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pin className="h-3.5 w-3.5 shrink-0" aria-label={t("pages.companySkills.pinnedSourceRevision", { defaultValue: "Pinned source revision" })} />
                    </TooltipTrigger>
                    <TooltipContent>{t("pages.companySkills.pinnedSourceRevision", { defaultValue: "Pinned source revision" })}</TooltipContent>
                  </Tooltip>
                  <span className="truncate font-mono text-foreground">{currentPin ?? t("pages.companySkills.untracked", { defaultValue: "untracked" })}</span>
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={onCheckUpdates} disabled={checkUpdatesPending || updateStatusLoading}>
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  {t("pages.companySkills.checkForUpdates", { defaultValue: "Check for updates" })}
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate ? (
                  <Button size="sm" className="w-full" onClick={onInstallUpdate} disabled={installUpdatePending}>
                    <ArrowUpCircle className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    {t("pages.companySkills.installUpdateAction", { defaultValue: "Install update" })}{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                ) : updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading ? (
                  <p className="text-xs text-muted-foreground">{t("pages.companySkills.upToDateDot", { defaultValue: "Up to date." })}</p>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Config lives behind a gear; sharing + danger zone open in a modal
              (PAP-10907 A). */}
          <section>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            >
              <Settings className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t("pages.companySkills.settings", { defaultValue: "Settings" })}</span>
            </button>
          </section>
        </aside>
      </div>

      {/* Floating save bar: stays visible while a file edit is dirty so the
          unsaved state is obvious (PAP-10907 J). */}
      {isDirty ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
          <span className="text-sm text-muted-foreground">{t("pages.companySkills.unsavedChanges", { defaultValue: "Unsaved changes" })}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(savedFileContent);
              setEditMode(false);
            }}
            disabled={savePending}
          >
            {t("pages.companySkills.discard", { defaultValue: "Discard" })}
          </Button>
          <Button size="sm" onClick={onSave} disabled={savePending}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {savePending ? t("pages.companySkills.savingEllipsis", { defaultValue: "Saving…" }) : t("pages.companySkills.saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </div>
      ) : null}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pages.companySkills.skillSettings", { defaultValue: "Skill settings" })}</DialogTitle>
            <DialogDescription>{t("pages.companySkills.manageSharing", { name: detail.name, defaultValue: "Manage how {{name}} is shared." })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.sharingLabel", { defaultValue: "Sharing" })}</label>
              <select
                value={detail.sharingScope === "public_link" ? "company" : detail.sharingScope}
                onChange={(event) => onUpdateSharingScope(event.target.value as Exclude<CompanySkillSharingScope, "public_link">)}
                disabled={updateSharingPending}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="company">{t("pages.companySkills.sharingCompanyOption", { defaultValue: "Company — visible inside this company" })}</option>
                <option value="private">{t("pages.companySkills.sharingPrivateOption", { defaultValue: "Private — only visible in your library" })}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("pages.companySkills.publicLinkComingLater", { defaultValue: "Public link sharing is coming later." })}</p>
            </div>
            {detail.editable ? (
              <div className="rounded-md border border-destructive/40 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-destructive">{t("pages.companySkills.dangerZone", { defaultValue: "Danger zone" })}</div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="min-w-0 text-xs text-muted-foreground">{t("pages.companySkills.removeFromLibrary", { defaultValue: "Remove this skill from the company library." })}</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    onClick={onDelete}
                    disabled={deletePending}
                    title={detail.usedByAgents.length > 0 ? t("pages.companySkills.detachBeforeRemoving", { defaultValue: "Detach this skill from all agents before removing it." }) : undefined}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {deletePending ? t("pages.companySkills.removingEllipsis", { defaultValue: "Removing…" }) : t("pages.companySkills.remove", { defaultValue: "Remove" })}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillPane({
  loading,
  detail,
  file,
  fileLoading,
  updateStatus,
  updateStatusLoading,
  viewMode,
  editMode,
  draft,
  setViewMode,
  setEditMode,
  setDraft,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onDelete,
  deletePending,
  onSave,
  savePending,
  attachAgents,
  versions,
  onSubmitAttach,
  attachPending,
}: {
  loading: boolean;
  detail: CompanySkillDetail | null | undefined;
  file: CompanySkillFileDetail | null | undefined;
  fileLoading: boolean;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  viewMode: "preview" | "code";
  editMode: boolean;
  draft: string;
  setViewMode: (mode: "preview" | "code") => void;
  setEditMode: (value: boolean) => void;
  setDraft: (value: string) => void;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  onSave: () => void;
  savePending: boolean;
  attachAgents: AttachAgentOption[];
  versions: CompanySkillVersion[];
  onSubmitAttach: (ids: string[], versionId: string | null) => void;
  attachPending: boolean;
}) {
  const { t } = useTranslation();
  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return (
      <EmptyState
        icon={Boxes}
        message={t("pages.companySkills.selectSkillToInspectFiles", { defaultValue: "Select a skill to inspect its files." })}
      />
    );
  }

  const source = sourceMeta(detail.sourceBadge, detail.sourceLabel);
  const SourceIcon = source.icon;
  const usedBy = detail.usedByAgents;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(detail.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const displaySourcePath = detail.sourcePath ? middleTruncate(detail.sourcePath) : null;
  const removeBlocked = usedBy.length > 0;
  const removeDisabledReason = removeBlocked
    ? t("pages.companySkills.detachBeforeRemoving", { defaultValue: "Detach this skill from all agents before removing it." })
    : null;

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-2xl font-semibold">
              <SourceIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              {detail.name}
            </h1>
            {detail.description && (
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{detail.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={deletePending}
              title={removeDisabledReason ?? undefined}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {deletePending ? t("pages.companySkills.removing", { defaultValue: "Removing..." }) : t("pages.companySkills.remove", { defaultValue: "Remove" })}
            </Button>
            {detail.editable ? (
              <button
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setEditMode(!editMode)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode ? t("pages.companySkills.stopEditing", { defaultValue: "Stop editing" }) : t("pages.companySkills.edit", { defaultValue: "Edit" })}
              </button>
            ) : (
              <div className="text-sm text-muted-foreground">{detail.editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("pages.companySkills.sourceLabel", { defaultValue: "Source" })}</span>
              <span className="flex min-w-0 items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {detail.sourcePath && displaySourcePath ? (
                  <>
                    <span
                      className="block min-w-0 max-w-[min(34rem,55vw)] truncate font-mono text-xs text-muted-foreground"
                      title={detail.sourcePath}
                    >
                      {displaySourcePath}
                    </span>
                    <CopyText
                      text={detail.sourcePath}
                      copiedLabel={t("pages.companySkills.copiedPath", { defaultValue: "Copied path" })}
                      ariaLabel={t("pages.companySkills.copySourcePath", { defaultValue: "Copy source path" })}
                      title={t("pages.companySkills.copySourcePath", { defaultValue: "Copy source path" })}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </>
                ) : (
                  <span className="truncate">{source.label}</span>
                )}
              </span>
            </div>
            {detail.sourceType === "github" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("pages.companySkills.pinLabel", { defaultValue: "Pin" })}</span>
                <span className="font-mono text-xs">{currentPin ?? t("pages.companySkills.untracked", { defaultValue: "untracked" })}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">{t("pages.companySkills.tracking", { ref: updateStatus.trackingRef, defaultValue: "tracking {{ref}}" })}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  {t("pages.companySkills.checkForUpdates", { defaultValue: "Check for updates" })}
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    {t("pages.companySkills.installUpdateAction", { defaultValue: "Install update" })}{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">{t("pages.companySkills.upToDate", { defaultValue: "Up to date" })}</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("pages.companySkills.keyLabel", { defaultValue: "Key" })}</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("pages.companySkills.modeLabel", { defaultValue: "Mode" })}</span>
              <span>{detail.editable ? t("pages.companySkills.modeEditable", { defaultValue: "Editable" }) : t("pages.companySkills.modeReadOnly", { defaultValue: "Read only" })}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("pages.companySkills.trustLabel", { defaultValue: "Trust" })}</span>
            <TrustChip level={detail.trustLevel} />
            <CompatChip compatibility={detail.compatibility} />
            {readonlyMetadataValue(detail.metadata, "userModifiedAt") ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-200">
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    {t("pages.companySkills.locallyModified", { defaultValue: "Locally modified" })}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("pages.companySkills.locallyModifiedTooltip", { defaultValue: "You have edited this skill after installing. Updates from the catalog will overwrite your changes." })}</TooltipContent>
              </Tooltip>
            ) : null}
            {(() => {
              const packageName = readonlyMetadataValue(detail.metadata, "originPackageName") ?? readonlyMetadataValue(detail.metadata, "catalogPackageName");
              const packageVersion = readonlyMetadataValue(detail.metadata, "originVersion") ?? readonlyMetadataValue(detail.metadata, "catalogPackageVersion");
              return <ProvenanceBadge packageName={packageName} packageVersion={packageVersion} />;
            })()}
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("pages.companySkills.usedByLabel", { defaultValue: "Used by" })}</span>
              <AttachAgentsPopover
                agents={attachAgents}
                attachedAgentIds={usedBy.map((agent) => agent.id)}
                versions={versions}
                selectedVersionId={usedBy.find((agent) => agent.versionId)?.versionId ?? null}
                pending={attachPending}
                onSubmit={onSubmitAttach}
              />
            </div>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">{t("pages.companySkills.noAgentsAttached", { defaultValue: "No agents attached" })}</span>
            ) : (
              <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {usedBy.map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.urlKey}/skills`}
                    className="group rounded-md border border-transparent p-2 no-underline hover:border-border hover:bg-accent/40"
                  >
                    <Identity name={agent.name} size="sm" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">{file?.path ?? "SKILL.md"}</div>
          </div>
          <div className="flex items-center gap-2">
            {file?.markdown && !editMode && (
              <div className="flex items-center border border-border">
                <button
                  className={cn("px-3 py-1.5 text-sm", viewMode === "preview" && "text-foreground", viewMode !== "preview" && "text-muted-foreground")}
                  onClick={() => setViewMode("preview")}
                >
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" />
                    {t("pages.companySkills.viewTab", { defaultValue: "View" })}
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    {t("pages.companySkills.codeTab", { defaultValue: "Code" })}
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  {t("pages.companySkills.cancel", { defaultValue: "Cancel" })}
                </Button>
                <Button size="sm" onClick={onSave} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? t("pages.companySkills.saving", { defaultValue: "Saving..." }) : t("pages.companySkills.save", { defaultValue: "Save" })}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-[560px] px-5 py-5">
        {fileLoading ? (
          <PageSkeleton variant="detail" />
        ) : !file ? (
          <div className="text-sm text-muted-foreground">{t("pages.companySkills.selectFileToInspect", { defaultValue: "Select a file to inspect." })}</div>
        ) : editMode && file.editable ? (
          file.markdown ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              bordered={false}
              className="min-h-[520px]"
            />
          ) : (
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
            />
          )
        ) : file.markdown && viewMode === "preview" ? (
          <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body}</MarkdownBody>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{file.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function CompanySkills() {
  const { t } = useTranslation();
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const adapterCaps = useAdapterCapabilities();
  const [skillFilter, setSkillFilter] = useState("");
  const [source, setSource] = useState("");
  const [emptySourceHelpOpen, setEmptySourceHelpOpen] = useState(false);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, Set<string>>>({});
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [displayedDetail, setDisplayedDetail] = useState<CompanySkillDetail | null>(null);
  const [displayedFile, setDisplayedFile] = useState<CompanySkillFileDetail | null>(null);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargetSkillId, setDeleteTargetSkillId] = useState<string | null>(null);
  const [deleteTargetDetail, setDeleteTargetDetail] = useState<CompanySkillDetail | null>(null);
  const [catalogFilter, setCatalogFilter] = useState("");
  const [catalogKindFilter, setCatalogKindFilter] = useState<"all" | "bundled" | "optional">("all");
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<string>("");
  const [catalogSelectedPath, setCatalogSelectedPath] = useState<string>("SKILL.md");
  const [expandedCatalogSkillId, setExpandedCatalogSkillId] = useState<string | null>(null);
  const [expandedCatalogDirs, setExpandedCatalogDirs] = useState<Record<string, Set<string>>>({});
  const [installDialogState, setInstallDialogState] = useState<{
    open: boolean;
    catalogSkill: CatalogSkill | null;
    conflict: CompanySkillListItem | null;
    defaultSlug: string | null;
    defaultForce: boolean;
    defaultAction: "install" | "update" | "replace";
    error: string | null;
  }>({ open: false, catalogSkill: null, conflict: null, defaultSlug: null, defaultForce: false, defaultAction: "install", error: null });
  const [discoverySearch, setDiscoverySearch] = useState("");
  const [discoverySort, setDiscoverySort] = useState<DiscoverySort>("agents");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<SkillCreateDraft>(() => buildBlankSkillDraft());
  const [createError, setCreateError] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillToken = parsedRoute.skillToken;
  const selectedPath = parsedRoute.filePath;
  const viewParam = searchParams.get("view");
  const activeView: "installed" | "catalog" = viewParam === "catalog" ? "catalog" : "installed";
  const sourceFilterParam = searchParams.get("source") ?? "all";
  const sourceFilter: SourceFilter = (["all", "company", "bundled", "optional", "external"] as SourceFilter[]).includes(sourceFilterParam as SourceFilter)
    ? (sourceFilterParam as SourceFilter)
    : "all";
  const selectedCatalogRef = searchParams.get("catalog");
  const tabParam = searchParams.get("tab");
  const discoveryTab: DiscoveryTab = DISCOVERY_TABS.includes(tabParam as DiscoveryTab)
    ? (tabParam as DiscoveryTab)
    : "all";
  const detailTab: SkillDetailTab = (["overview", "files", "versions", "agents"] as SkillDetailTab[]).includes(tabParam as SkillDetailTab)
    ? (tabParam as SkillDetailTab)
    : selectedPath !== "SKILL.md"
      ? "files"
      : "overview";
  const discoveryCategory = searchParams.get("category");
  // Discovery grid owns `/skills` whenever no specific skill or catalog entry is
  // selected; selecting either drops into the existing master/detail surfaces.
  const isDiscovery = !routeSkillToken && !selectedCatalogRef;

  function setDiscoveryTab(tab: DiscoveryTab) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (tab === "all") params.delete("tab");
      else params.set("tab", tab);
      params.delete("category");
      return params;
    });
  }

  function setDetailTab(tab: SkillDetailTab) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (tab === "overview") params.delete("tab");
      else params.set("tab", tab);
      return params;
    });
  }

  function setDiscoveryCategory(slug: string | null) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (slug) params.set("category", slug);
      else params.delete("category");
      return params;
    });
  }

  function setSourceFilter(next: SourceFilter) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "all") params.delete("source");
      else params.set("source", next);
      return params;
    });
  }

  function selectCatalog(catalogRef: string | null, path = "SKILL.md") {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (catalogRef) params.set("catalog", catalogRef);
      else params.delete("catalog");
      return params;
    });
    setCatalogSelectedPath(path);
  }

  function openCreateWizard(initialDraft: SkillCreateDraft = buildBlankSkillDraft()) {
    setCreateDraft(initialDraft);
    setCreateError(null);
    setCreateDialogOpen(true);
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: t("pages.companySkills.breadcrumbSkills", { defaultValue: "Skills" }), href: "/skills" },
      ...(routeSkillToken ? [{ label: t("pages.companySkills.breadcrumbDetail", { defaultValue: "Detail" }) }] : []),
    ]);
  }, [routeSkillToken, setBreadcrumbs, t]);

  // The old split catalog view no longer exists — catalog/bundled skills now open
  // as a regular full page keyed by `?catalog=<ref>`. Strip the legacy `view`
  // param so stale `?view=catalog` deep links land on the new surface (PAP-10907).
  useEffect(() => {
    if (!searchParams.has("view")) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("view");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const installedSkills = skillsQuery.data ?? [];
  const routeResolution = useMemo(
    () => resolveSkillRouteToken(routeSkillToken, installedSkills),
    [routeSkillToken, installedSkills],
  );

  // At `/skills` root the discovery grid is shown, so we no longer auto-select
  // the first skill; a skill is only "selected" once it is in the route.
  const selectedSkillId = routeResolution.skill?.id ?? null;

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(selectedCompanyId ?? "", selectedSkillId ?? "", selectedPath),
    queryFn: () => companySkillsApi.file(selectedCompanyId!, selectedSkillId!, selectedPath),
    enabled: Boolean(selectedCompanyId && selectedSkillId && selectedPath),
  });

  const versionsQuery = useQuery({
    queryKey: queryKeys.companySkills.versions(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.versions(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId),
  });

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.updateStatus(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(
      selectedCompanyId
      && selectedSkillId
      && (detailQuery.data?.sourceType === "github" || displayedDetail?.sourceType === "github"),
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!routeResolution.skill || !routeResolution.shouldRedirect || skillsQuery.isLoading) return;
    const search = searchParams.toString();
    navigate(
      {
        pathname: skillRoute(routeResolution.skill, installedSkills, selectedPath),
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  }, [installedSkills, navigate, routeResolution, searchParams, selectedPath, skillsQuery.isLoading]);

  useEffect(() => {
    setExpandedSkillId(selectedSkillId);
  }, [selectedSkillId]);

  useEffect(() => {
    if (!selectedSkillId || selectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(selectedPath);
    if (parents.length === 0) return;
    setExpandedDirs((current) => {
      const next = new Set(current[selectedSkillId] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedSkillId]: next } : current;
    });
  }, [selectedPath, selectedSkillId]);

  useEffect(() => {
    setEditMode(false);
  }, [selectedSkillId, selectedPath]);

  useEffect(() => {
    if (detailQuery.data) {
      setDisplayedDetail(detailQuery.data);
    }
  }, [detailQuery.data]);

  useEffect(() => {
    if (fileQuery.data) {
      setDisplayedFile(fileQuery.data);
      setDraft(fileQuery.data.markdown ? splitFrontmatter(fileQuery.data.content).body : fileQuery.data.content);
    }
  }, [fileQuery.data]);

  useEffect(() => {
    if (selectedSkillId) return;
    setDisplayedDetail(null);
    setDisplayedFile(null);
  }, [selectedSkillId]);

  const activeDetail = detailQuery.data ?? displayedDetail;
  const activeFile = fileQuery.data ?? displayedFile;

  function routeForSkill(skill: CompanySkillRouteSubject, path?: string | null) {
    return skillRoute(skill, withRouteSkill(installedSkills, skill), path);
  }

  function routeForSkillId(skillId: string, path?: string | null) {
    const skill = installedSkills.find((entry) => entry.id === skillId)
      ?? (activeDetail?.id === skillId ? activeDetail : null);
    return skill ? routeForSkill(skill, path) : skillRoute(skillId, path);
  }

  function openDeleteDialog() {
    setDeleteTargetSkillId(selectedSkillId);
    setDeleteTargetDetail(activeDetail ?? null);
    setDeleteOpen(true);
  }

  function closeDeleteDialog(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteTargetSkillId(null);
      setDeleteTargetDetail(null);
    }
  }

  const importSkill = useMutation({
    mutationFn: (importSource: string) => companySkillsApi.importFromSource(selectedCompanyId!, importSource),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      if (result.imported[0]) navigate(routeForSkill(result.imported[0]));
      pushToast({
        tone: "success",
        title: t("pages.companySkills.toastSkillsImportedTitle", { defaultValue: "Skills imported" }),
        body: t("pages.companySkills.toastSkillsImportedBody", { count: result.imported.length, defaultValue: "{{count}} skills added." }),
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: t("pages.companySkills.toastImportWarningsTitle", { defaultValue: "Import warnings" }), body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastSkillImportFailedTitle", { defaultValue: "Skill import failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToImport", { defaultValue: "Failed to import skill source." }),
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) => companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      navigate(routeForSkill(skill));
      setCreateDialogOpen(false);
      setCreateError(null);
      setCreateDraft(buildBlankSkillDraft());
      pushToast({
        tone: "success",
        title: skill.forkedFromSkillId ? t("pages.companySkills.toastSkillForkCreatedTitle", { defaultValue: "Skill fork created" }) : t("pages.companySkills.toastSkillCreatedTitle", { defaultValue: "Skill created" }),
        body: t("pages.companySkills.toastSkillCreatedBody", { name: skill.name, defaultValue: "{{name}} is now editable in the Paperclip workspace." }),
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("pages.companySkills.toastFailedToCreate", { defaultValue: "Failed to create skill." });
      setCreateError(message);
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastSkillCreationFailedTitle", { defaultValue: "Skill creation failed" }),
        body: message,
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onMutate: () => {
      setScanStatusMessage(t("pages.companySkills.scanningWorkspaces", { defaultValue: "Scanning project workspaces for skills..." }));
    },
    onSuccess: async (result) => {
      setScanStatusMessage(t("pages.companySkills.refreshingSkillsList", { defaultValue: "Refreshing skills list..." }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      const summary = formatProjectScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: t("pages.companySkills.toastScanCompleteTitle", { defaultValue: "Project skill scan complete" }),
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: t("pages.companySkills.toastConflictsFoundTitle", { defaultValue: "Skill conflicts found" }),
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: t("pages.companySkills.toastScanWarningsTitle", { defaultValue: "Scan warnings" }),
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastScanFailedTitle", { defaultValue: "Project skill scan failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToScan", { defaultValue: "Failed to scan project workspaces." }),
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: () => companySkillsApi.updateFile(
      selectedCompanyId!,
      selectedSkillId!,
      selectedPath,
      activeFile?.markdown ? mergeFrontmatter(activeFile.content, draft) : draft,
    ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
      ]);
      setDraft(result.markdown ? splitFrontmatter(result.content).body : result.content);
      setEditMode(false);
      pushToast({
        tone: "success",
        title: t("pages.companySkills.toastSkillSavedTitle", { defaultValue: "Skill saved" }),
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastSaveFailedTitle", { defaultValue: "Save failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToSave", { defaultValue: "Failed to save skill file." }),
      });
    },
  });

  const toggleStar = useMutation({
    mutationFn: () => {
      if (!activeDetail) throw new Error("Select a skill first.");
      return activeDetail.starredByCurrentActor
        ? companySkillsApi.unstar(selectedCompanyId!, activeDetail.id)
        : companySkillsApi.star(selectedCompanyId!, activeDetail.id);
    },
    onSuccess: async () => {
      if (!activeDetail) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, activeDetail.id) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastStarFailedTitle", { defaultValue: "Star failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToStar", { defaultValue: "Failed to update star." }),
      });
    },
  });

  const updateSkillSettings = useMutation({
    mutationFn: (payload: { skillId: string; sharingScope: Exclude<CompanySkillSharingScope, "public_link"> }) =>
      companySkillsApi.update(selectedCompanyId!, payload.skillId, { sharingScope: payload.sharingScope }),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, skill.id) }),
      ]);
      pushToast({ tone: "success", title: t("pages.companySkills.toastSharingUpdatedTitle", { defaultValue: "Sharing updated" }), body: skill.sharingScope === "private" ? t("pages.companySkills.scopePrivate", { defaultValue: "Private" }) : t("pages.companySkills.scopeCompany", { defaultValue: "Company" }) });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastSharingUpdateFailedTitle", { defaultValue: "Sharing update failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToUpdateSharing", { defaultValue: "Failed to update sharing scope." }),
      });
    },
  });

  const installUpdate = useMutation({
    mutationFn: () => companySkillsApi.installUpdate(selectedCompanyId!, selectedSkillId!),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
      ]);
      navigate(routeForSkill(skill, selectedPath));
      pushToast({
        tone: "success",
        title: t("pages.companySkills.toastSkillUpdatedTitle", { defaultValue: "Skill updated" }),
        body: skill.sourceRef ? t("pages.companySkills.toastPinnedTo", { ref: shortRef(skill.sourceRef), defaultValue: "Pinned to {{ref}}" }) : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastUpdateFailedTitle", { defaultValue: "Update failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToInstallUpdate", { defaultValue: "Failed to install skill update." }),
      });
    },
  });

  const catalogListQuery = useQuery({
    queryKey: queryKeys.companySkills.catalog(),
    queryFn: () => companySkillsApi.catalogList(),
    enabled: Boolean(selectedCompanyId),
    staleTime: 60_000,
  });

  const catalogDetailQuery = useQuery({
    queryKey: queryKeys.companySkills.catalogDetail(selectedCatalogRef ?? ""),
    queryFn: () => companySkillsApi.catalogDetail(selectedCatalogRef!),
    enabled: Boolean(selectedCompanyId && selectedCatalogRef),
    staleTime: 60_000,
  });

  const catalogFileQuery = useQuery({
    queryKey: queryKeys.companySkills.catalogFile(selectedCatalogRef ?? "", catalogSelectedPath),
    queryFn: () => companySkillsApi.catalogFile(selectedCatalogRef!, catalogSelectedPath),
    enabled: Boolean(selectedCompanyId && selectedCatalogRef && catalogSelectedPath),
    staleTime: 60_000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const installedByKey = useMemo(
    () => new Map(installedSkills.map((skill) => [skill.key, skill])),
    [installedSkills],
  );
  const catalogCategories = useMemo(() => {
    const set = new Set<string>();
    for (const skill of catalogListQuery.data ?? []) set.add(skill.category);
    return Array.from(set).sort();
  }, [catalogListQuery.data]);

  // --- Discovery grid derived data (PAP-10879) ---
  const discoveryCards = useMemo(
    () => buildDiscoveryCards(installedSkills, catalogListQuery.data ?? []),
    [installedSkills, catalogListQuery.data],
  );
  const discoveryTabCounts = useMemo(() => ({
    all: discoveryCards.length,
    installed: discoveryCards.filter((card) => card.installed).length,
    catalog: discoveryCards.filter((card) => card.catalogRef != null).length,
    bundled: discoveryCards.filter((card) => card.required).length,
  }), [discoveryCards]);
  const discoveryTabCards = useMemo(
    () => cardsForTab(discoveryCards, discoveryTab),
    [discoveryCards, discoveryTab],
  );
  const discoveryCategoryCounts = useMemo<DiscoveryCategory[]>(() => {
    const counts = new Map<string, number>();
    for (const card of discoveryTabCards) {
      for (const category of card.categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ slug, count }))
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  }, [discoveryTabCards]);
  const visibleDiscoveryCards = useMemo(() => {
    const filtered = discoveryTabCards.filter((card) => {
      if (discoveryCategory && !card.categories.includes(discoveryCategory)) return false;
      return discoveryMatchesSearch(card, discoverySearch.trim());
    });
    return sortDiscoveryCards(filtered, discoverySort, discoveryTab !== "bundled");
  }, [discoveryTabCards, discoveryCategory, discoverySearch, discoverySort, discoveryTab]);

  const selectedCatalogSkill = catalogDetailQuery.data
    ?? (catalogListQuery.data ?? []).find((entry) => entry.id === selectedCatalogRef || entry.key === selectedCatalogRef)
    ?? null;

  useEffect(() => {
    setExpandedCatalogSkillId(selectedCatalogSkill?.id ?? null);
  }, [selectedCatalogSkill?.id]);

  useEffect(() => {
    if (!selectedCatalogSkill || catalogSelectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(catalogSelectedPath);
    if (parents.length === 0) return;
    setExpandedCatalogDirs((current) => {
      const next = new Set(current[selectedCatalogSkill.id] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedCatalogSkill.id]: next } : current;
    });
  }, [catalogSelectedPath, selectedCatalogSkill]);

  const sourceCounts = useMemo<Record<SourceFilter, number>>(() => {
    const counts: Record<SourceFilter, number> = { all: installedSkills.length, company: 0, bundled: 0, optional: 0, external: 0 };
    for (const skill of installedSkills) {
      const cls = classifySource(skill);
      counts[cls] += 1;
    }
    return counts;
  }, [installedSkills]);
  const installCatalog = useMutation({
    mutationFn: (payload: { catalogSkillId: string; slug: string | null; force: boolean }) =>
      companySkillsApi.installCatalog(selectedCompanyId!, {
        catalogSkillId: payload.catalogSkillId,
        slug: payload.slug,
        force: payload.force,
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, result.skill.id) }),
      ]);
      setInstallDialogState((current) => ({ ...current, open: false, error: null }));
      pushToast({
        tone: "success",
        title: result.action === "created" ? t("pages.companySkills.toastSkillInstalledTitle", { defaultValue: "Skill installed" }) : result.action === "updated" ? t("pages.companySkills.toastSkillUpdatedTitle", { defaultValue: "Skill updated" }) : t("pages.companySkills.toastSkillUpToDateTitle", { defaultValue: "Skill is up to date" }),
        body: result.skill.name,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: t("pages.companySkills.toastInstallWarningsTitle", { defaultValue: "Install warnings" }), body: result.warnings[0] });
      }
      if (result.action === "created") {
        navigate(routeForSkill(result.skill));
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("pages.companySkills.toastFailedToInstallCatalog", { defaultValue: "Failed to install catalog skill." });
      setInstallDialogState((current) => ({ ...current, error: message }));
    },
  });

  const eligibleAgentsForAttach = useMemo(() => {
    const data = agentsQuery.data ?? [];
    return data.map((agent: Agent) => {
      const caps = adapterCaps(agent.adapterType);
      const requiredKeys: string[] = [];
      const usedSet = new Set((activeDetail?.usedByAgents ?? []).map((entry) => entry.id));
      const isRequired = false; // detection currently lives server-side; default false until detail surfaces required state
      return {
        id: agent.id,
        name: agent.name,
        adapterType: agent.adapterType,
        supportsSkills: Boolean(caps.supportsSkills),
        required: isRequired,
        icon: agent.icon,
        paused: agent.status === "paused" || agent.pausedAt != null,
        attached: usedSet.has(agent.id),
        requiredKeys,
      };
    });
  }, [agentsQuery.data, adapterCaps, activeDetail]);

  const attachAgentsMutation = useMutation({
    mutationFn: async (input: { agentId: string; desiredSkills: Array<string | AgentDesiredSkillEntry> }) => {
      return agentsApi.syncSkills(input.agentId, input.desiredSkills, selectedCompanyId ?? undefined);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId ?? "") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.versions(selectedCompanyId!, selectedSkillId ?? "") }),
      ]);
    },
  });

  async function handleAttachSubmit(nextAgentIds: string[], versionId: string | null = null) {
    if (!activeDetail) return;
    const skillKey = activeDetail.key;
    const targetSet = new Set(nextAgentIds);
    const current = (activeDetail.usedByAgents ?? []).map((entry) => entry.id);
    const currentSet = new Set(current);
    const currentVersionByAgent = new Map(
      (activeDetail.usedByAgents ?? []).map((entry) => [entry.id, entry.versionId ?? null]),
    );
    const toAdd = nextAgentIds.filter((id) => !currentSet.has(id));
    const toRemove = current.filter((id) => !targetSet.has(id));
    const toUpdateVersion = nextAgentIds.filter((id) =>
      currentSet.has(id) && (currentVersionByAgent.get(id) ?? null) !== versionId,
    );
    const affected = new Set<string>([...toAdd, ...toRemove, ...toUpdateVersion]);
    if (affected.size === 0) {
      return;
    }
    try {
      for (const agentId of affected) {
        const snapshot = await agentsApi.skills(agentId, selectedCompanyId ?? undefined);
        const currentEntries: AgentDesiredSkillEntry[] = (snapshot.desiredSkillEntries ?? snapshot.desiredSkills.map((key) => ({ key, versionId: null })))
          .filter((entry) => entry.key !== skillKey);
        if (targetSet.has(agentId)) {
          currentEntries.push({ key: skillKey, versionId });
        }
        await attachAgentsMutation.mutateAsync({ agentId, desiredSkills: currentEntries });
      }
      pushToast({ tone: "success", title: t("pages.companySkills.toastAgentsUpdatedTitle", { defaultValue: "Agents updated" }), body: t("pages.companySkills.toastAgentsAttachedBody", { count: nextAgentIds.length, defaultValue: "{{count}} agent(s) attached." }) });
    } catch (error) {
      pushToast({ tone: "error", title: t("pages.companySkills.toastUpdateFailedTitle", { defaultValue: "Update failed" }), body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToUpdateAgentSkills", { defaultValue: "Failed to update agent skills." }) });
    }
  }

  function openInstallDialog(catalogSkill: CatalogSkill) {
    const existing = installedByKey.get(catalogSkill.key) ?? null;
    const installedHash = existing?.originHash ?? null;
    const action: "install" | "update" | "replace" = existing
      ? installedHash && installedHash !== catalogSkill.contentHash
        ? "update"
        : existing.sourceType !== "catalog"
          ? "replace"
          : "update"
      : "install";
    setInstallDialogState({
      open: true,
      catalogSkill,
      conflict: existing,
      defaultSlug: existing?.slug ?? catalogSkill.slug,
      defaultForce: action === "replace",
      defaultAction: action,
      error: null,
    });
  }

  const deleteSkill = useMutation({
    mutationFn: () => companySkillsApi.delete(selectedCompanyId!, deleteTargetSkillId!),
    onSuccess: async (skill) => {
      closeDeleteDialog(false);
      setDisplayedDetail(null);
      setDisplayedFile(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        ...(deleteTargetSkillId ? [
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, deleteTargetSkillId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, deleteTargetSkillId) }),
        ] : []),
        ...(deleteTargetSkillId ? [
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.file(selectedCompanyId!, deleteTargetSkillId, selectedPath),
          }),
        ] : []),
      ]);
      await queryClient.refetchQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
        type: "active",
      });
      navigate("/skills", { replace: true });
      pushToast({
        tone: "success",
        title: t("pages.companySkills.toastSkillRemovedTitle", { defaultValue: "Skill removed" }),
        body: t("pages.companySkills.toastSkillRemovedBody", { name: skill.name, defaultValue: "{{name}} was removed from the company skill library." }),
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("pages.companySkills.toastRemoveFailedTitle", { defaultValue: "Remove failed" }),
        body: error instanceof Error ? error.message : t("pages.companySkills.toastFailedToRemove", { defaultValue: "Failed to remove skill." }),
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message={t("pages.companySkills.selectCompany", { defaultValue: "Select a company to manage skills." })} />;
  }

  function handleAddSkillSource() {
    const trimmedSource = source.trim();
    if (trimmedSource.length === 0) {
      setEmptySourceHelpOpen(true);
      return;
    }
    importSkill.mutate(trimmedSource);
  }

  // Opening a card stays inside the new store and always lands on a regular full
  // page: installed skills go to their detail route; catalog/bundled/optional
  // skills open the standalone catalog page (no modal, no legacy split view).
  function openDiscoveryCard(card: DiscoveryCard) {
    if (card.skillId) {
      navigate(routeForSkillId(card.skillId));
      return;
    }
    if (card.catalogRef) {
      selectCatalog(card.catalogRef);
    }
  }

  // "Back to store" returns to the discovery grid while keeping the tab /
  // category / source filters the user arrived with (PAP-10907).
  const backToStoreParams = new URLSearchParams(searchParams);
  backToStoreParams.delete("catalog");
  const backToStoreParamString = backToStoreParams.toString();
  const backToStoreHref = backToStoreParamString ? `/skills?${backToStoreParamString}` : "/skills";

  // Surface the upstream catalog source (GitHub owner/repo/path) on the installed
  // skill detail, matched by canonical key (PAP-10907).
  const catalogSourceForDetail = activeDetail
    ? (catalogListQuery.data ?? []).find((entry) => entry.key === activeDetail.key)?.source ?? null
    : null;

  return (
    <>
      <Dialog open={deleteOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pages.companySkills.removeSkillTitle", { defaultValue: "Remove skill" })}</DialogTitle>
            <DialogDescription>
              {t("pages.companySkills.removeSkillDescription", { defaultValue: "Remove this skill from the company library. If any agents still use it, removal will be blocked until it is detached." })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {deleteTargetDetail
                ? t("pages.companySkills.aboutToRemoveNamed", { name: deleteTargetDetail.name, defaultValue: "You are about to remove {{name}}." })
                : t("pages.companySkills.aboutToRemoveThis", { defaultValue: "You are about to remove this skill." })}
            </p>
            {deleteTargetDetail?.usedByAgents?.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                {t("pages.companySkills.currentlyUsedBy", { names: deleteTargetDetail.usedByAgents.map((agent) => agent.name).join(", "), defaultValue: "Currently used by {{names}}." })}
              </div>
            ) : null}
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                {t("pages.companySkills.detachToEnableRemoval", { defaultValue: "Detach this skill from all agents to enable removal." })}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <Button variant="ghost" onClick={() => closeDeleteDialog(false)}>
                {t("pages.companySkills.close", { defaultValue: "Close" })}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => closeDeleteDialog(false)} disabled={deleteSkill.isPending}>
                  {t("pages.companySkills.cancel", { defaultValue: "Cancel" })}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteSkill.mutate()}
                  disabled={deleteSkill.isPending || !deleteTargetSkillId}
                >
                  {deleteSkill.isPending ? t("pages.companySkills.removing", { defaultValue: "Removing..." }) : t("pages.companySkills.removeSkillButton", { defaultValue: "Remove skill" })}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pages.companySkills.addSkillSourceTitle", { defaultValue: "Add a skill source" })}</DialogTitle>
            <DialogDescription>
              {t("pages.companySkills.addSkillSourceDescription", { defaultValue: "Paste a local path, GitHub URL, or `skills.sh` command into the field first." })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("pages.companySkills.browseSkillsSh", { defaultValue: "Browse skills.sh" })}</span>
                <span className="mt-1 block text-muted-foreground">
                  {t("pages.companySkills.findInstallCommands", { defaultValue: "Find install commands and paste one here." })}
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/search?q=SKILL.md&type=code"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("pages.companySkills.searchGithub", { defaultValue: "Search GitHub" })}</span>
                <span className="mt-1 block text-muted-foreground">
                  {t("pages.companySkills.lookForReposHere", { defaultValue: "Look for repositories with `SKILL.md`, then paste the repo URL here." })}
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <InstallPreviewDialog
        open={installDialogState.open}
        onOpenChange={(open) => setInstallDialogState((current) => ({ ...current, open, error: open ? current.error : null }))}
        skill={installDialogState.catalogSkill}
        packageName={installDialogState.catalogSkill?.packageName ?? installDialogState.conflict?.packageName ?? null}
        packageVersion={installDialogState.catalogSkill?.packageVersion ?? installDialogState.conflict?.packageVersion ?? null}
        conflict={installDialogState.conflict}
        defaultSlug={installDialogState.defaultSlug}
        defaultForce={installDialogState.defaultForce}
        defaultAction={installDialogState.defaultAction}
        isPending={installCatalog.isPending}
        error={installDialogState.error}
        onConfirm={({ slug, force }) => {
          if (!installDialogState.catalogSkill) return;
          installCatalog.mutate({
            catalogSkillId: installDialogState.catalogSkill.id,
            slug,
            force,
          });
        }}
      />

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{createDraft.forkedFromSkillId ? t("pages.companySkills.forkSkillTitle", { defaultValue: "Fork skill" }) : t("pages.companySkills.createNewSkillTitle", { defaultValue: "Create a new skill" })}</DialogTitle>
            <DialogDescription>
              {createDraft.forkedFromSkillId
                ? t("pages.companySkills.forkSkillDescription", { defaultValue: "Review the fork metadata and create an editable company copy." })
                : t("pages.companySkills.createSkillDescription", { defaultValue: "Create an editable company skill in the Paperclip workspace." })}
            </DialogDescription>
          </DialogHeader>
          <NewSkillWizard
            initialDraft={createDraft}
            onCreate={(payload) => createSkill.mutate(payload)}
            isPending={createSkill.isPending}
            error={createError}
            onCancel={() => setCreateDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pages.companySkills.importSkillTitle", { defaultValue: "Import a skill" })}</DialogTitle>
            <DialogDescription>
              {t("pages.companySkills.importSkillDescription", { defaultValue: "Paste a local path, GitHub URL, or `skills.sh` command to import a skill into this company." })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-border pb-2">
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={t("pages.companySkills.importSourcePlaceholder", { defaultValue: "Paste path, GitHub URL, or skills.sh command" })}
                className="h-9 rounded-none border-0 px-0 shadow-none focus-visible:ring-0"
              />
              <Button size="sm" onClick={handleAddSkillSource} disabled={importSkill.isPending}>
                {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : t("pages.companySkills.import", { defaultValue: "Import" })}
              </Button>
            </div>
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-sm text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("pages.companySkills.browseSkillsSh", { defaultValue: "Browse skills.sh" })}</span>
                <span className="mt-1 block text-muted-foreground">{t("pages.companySkills.findInstallCommands", { defaultValue: "Find install commands and paste one here." })}</span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/search?q=SKILL.md&type=code"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-sm text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("pages.companySkills.searchGithub", { defaultValue: "Search GitHub" })}</span>
                <span className="mt-1 block text-muted-foreground">{t("pages.companySkills.lookForReposNoHere", { defaultValue: "Look for repositories with `SKILL.md`, then paste the repo URL." })}</span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
        </DialogContent>
      </Dialog>

      {isDiscovery ? (
        <DiscoveryGrid
          tab={discoveryTab}
          tabCounts={discoveryTabCounts}
          onTabChange={setDiscoveryTab}
          categories={discoveryCategoryCounts}
          categoryTotal={discoveryTabCards.length}
          activeCategory={discoveryCategory}
          onCategoryChange={setDiscoveryCategory}
          search={discoverySearch}
          onSearchChange={setDiscoverySearch}
          sort={discoverySort}
          onSortChange={setDiscoverySort}
          cards={visibleDiscoveryCards}
          onOpenCard={openDiscoveryCard}
          loading={skillsQuery.isLoading || catalogListQuery.isLoading}
          error={skillsQuery.error?.message ?? catalogListQuery.error?.message ?? null}
          totalCount={discoveryCards.length}
          onCreate={() => openCreateWizard()}
          onImport={() => setImportDialogOpen(true)}
          onBrowseCatalog={() => setDiscoveryTab("catalog")}
          onScan={() => scanProjects.mutate()}
          scanPending={scanProjects.isPending}
          scanStatus={scanStatusMessage}
        />
      ) : activeView === "installed" && selectedSkillId ? (
        <SkillDetailPage
          detail={activeDetail}
          catalogSource={catalogSourceForDetail}
          routeSkills={installedSkills}
          loading={skillsQuery.isLoading || detailQuery.isLoading}
          activeTab={detailTab}
          onTabChange={setDetailTab}
          selectedPath={selectedPath}
          file={activeFile}
          fileLoading={fileQuery.isLoading && !activeFile}
          viewMode={viewMode}
          editMode={editMode}
          draft={draft}
          setViewMode={setViewMode}
          setEditMode={setEditMode}
          setDraft={setDraft}
          onSave={() => saveFile.mutate()}
          savePending={saveFile.isPending}
          versions={versionsQuery.data ?? []}
          versionsLoading={versionsQuery.isLoading}
          attachAgents={eligibleAgentsForAttach}
          onSubmitAttach={handleAttachSubmit}
          attachPending={attachAgentsMutation.isPending}
          expandedDirs={expandedDirs[selectedSkillId] ?? new Set<string>()}
          onToggleDir={(path) => {
            setExpandedDirs((current) => {
              const next = new Set(current[selectedSkillId] ?? []);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return { ...current, [selectedSkillId]: next };
            });
          }}
          onSelectPath={(path) => {
            setDetailTab("files");
            navigate(routeForSkillId(selectedSkillId, path));
          }}
          updateStatus={updateStatusQuery.data}
          updateStatusLoading={updateStatusQuery.isLoading}
          onCheckUpdates={() => {
            void updateStatusQuery.refetch();
          }}
          checkUpdatesPending={updateStatusQuery.isFetching}
          onInstallUpdate={() => installUpdate.mutate()}
          installUpdatePending={installUpdate.isPending}
          onToggleStar={() => toggleStar.mutate()}
          starPending={toggleStar.isPending}
          onFork={() => activeDetail && openCreateWizard(buildForkSkillDraft(activeDetail))}
          onUpdateSharingScope={(sharingScope) => activeDetail && updateSkillSettings.mutate({ skillId: activeDetail.id, sharingScope })}
          updateSharingPending={updateSkillSettings.isPending}
          onDelete={openDeleteDialog}
          deletePending={deleteSkill.isPending}
        />
      ) : selectedCatalogRef ? (
        // Catalog / optional / bundled skills open as a regular full page in the
        // new store — no modal, no legacy split view (PAP-10907).
        <div className="min-h-[calc(100vh-12rem)]">
          <div className="border-b border-border px-4 py-3">
            <Link
              to={backToStoreHref}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              {t("pages.companySkills.backToStore", { defaultValue: "Back to store" })}
            </Link>
          </div>
          {catalogListQuery.isLoading || catalogDetailQuery.isLoading ? (
            <PageSkeleton variant="detail" />
          ) : !selectedCatalogSkill ? (
            <EmptyState icon={Boxes} message={t("pages.companySkills.catalogSkillNotFound", { defaultValue: "Catalog skill not found." })} />
          ) : (
            <div className="grid gap-0 xl:grid-cols-[14rem_minmax(0,1fr)]">
              <aside className="border-b border-border px-3 py-4 xl:border-b-0 xl:border-r">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("pages.companySkills.filesLabel", { defaultValue: "Files" })}</div>
                <SkillTree
                  nodes={buildTree(selectedCatalogSkill.files.map((file) => ({ path: file.path, kind: file.kind })))}
                  skillId={selectedCatalogSkill.id}
                  selectedPath={catalogSelectedPath}
                  expandedDirs={expandedCatalogDirs[selectedCatalogSkill.id] ?? new Set<string>()}
                  onToggleDir={(path) =>
                    setExpandedCatalogDirs((current) => {
                      const next = new Set(current[selectedCatalogSkill.id] ?? []);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return { ...current, [selectedCatalogSkill.id]: next };
                    })
                  }
                  onSelectPath={(path) => setCatalogSelectedPath(path)}
                  fileHref={() => `/skills?catalog=${encodeURIComponent(selectedCatalogRef)}`}
                />
              </aside>
              <div className="min-w-0">
                <CatalogDetailPane
                  skill={selectedCatalogSkill}
                  packageName={selectedCatalogSkill.packageName ?? installedByKey.get(selectedCatalogSkill.key)?.packageName ?? null}
                  packageVersion={selectedCatalogSkill.packageVersion ?? installedByKey.get(selectedCatalogSkill.key)?.packageVersion ?? null}
                  installedSkill={installedByKey.get(selectedCatalogSkill.key) ?? null}
                  installedSkillId={installedByKey.get(selectedCatalogSkill.key)?.id ?? null}
                  fileQuery={catalogFileQuery}
                  selectedPath={catalogSelectedPath}
                  onInstall={() => openInstallDialog(selectedCatalogSkill)}
                  onUpdate={() => openInstallDialog(selectedCatalogSkill)}
                  onOpenInstalled={(skillId) => navigate(routeForSkillId(skillId))}
                  loadingPrimaryAction={installCatalog.isPending}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-[calc(100vh-12rem)]">
          {skillsQuery.isLoading ? (
            <PageSkeleton variant="detail" />
          ) : (
            <EmptyState icon={Boxes} message={t("pages.companySkills.skillNotFound", { defaultValue: "Skill not found." })} />
          )}
        </div>
      )}
    </>
  );
}
