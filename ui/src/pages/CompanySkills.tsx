import { useEffect, useMemo, useRef, useState, type SVGProps } from "react";
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
  CompanySkillUpdateRequest,
  CompanySkillUpdateStatus,
  CompanySkillVersion,
} from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { foldersApi } from "../api/folders";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs, type Breadcrumb } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { CopyText } from "../components/CopyText";
import { Identity } from "../components/Identity";
import { AgentIcon } from "../components/AgentIconPicker";
import { AgentMultiSelect } from "../components/AgentMultiSelect";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import {
  SkillPolicyDenialNotice,
  useSkillPolicyDenial,
} from "@/components/skill-studio/SkillPolicySurfaces";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { cn, relativeTime } from "../lib/utils";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import {
  parseSkillRoute,
  skillRoute,
  skillStudioNewRoute,
  skillStudioRoute,
  withRouteSkill,
  resolveSkillRouteToken,
  type CompanySkillRouteSubject,
} from "../lib/company-skill-routes";
import {
  SKILL_CREATE_ACCENTS,
  buildBlankSkillDraft,
  buildForkSkillDraft,
  defaultSkillMarkdown,
  normalizeSkillDraftSlug,
  skillAccentColor,
  skillCreateDraftToPayload,
  splitCategoryDraft,
  type SkillCreateDraft,
} from "../lib/skill-create";
import { SkillCardIcon } from "../components/SkillCardIcon";
import { ImportSkillsFromProjectDialog } from "./skills/ImportSkillsFromProjectDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AllUnfiledBanner,
  BulkBar,
  DeleteFolderDialog,
  FolderChip,
  FolderFormDialog,
  FolderSwatch,
  MobileFolderSheet,
  MoveToMenu,
  folderSearchValue,
  normalizeFolderSelection,
  type FolderSelection,
} from "../components/folders/FolderControls";
import {
  FolderBreadcrumb,
  MoveToFolderDialog,
  SkillFolderRail,
  folderBreadcrumbTrail,
  reservedRootLabel,
  isBundledFolder,
  skillFolderDisplayPath,
  skillFolderPathDisplayFallback,
  subtreeFolderIds,
  treeFromResult,
} from "../components/folders/SkillFolderTree";
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
  FolderInput,
  FolderOpen,
  FolderSearch,
  GitFork,
  Github,
  Globe,
  HelpCircle,
  LayoutGrid,
  Link2,
  Lock,
  ExternalLink,
  FlaskConical,
  MoreHorizontal,
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
  Hash,
  History,
  X,
  XOctagon,
} from "lucide-react";
import type { FolderListItem, FolderListResult } from "@paperclipai/shared";
import { t, useTranslation } from "@/i18n";

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
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: t("companySkills.source.skillsShManaged") };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: t("companySkills.source.skillsShManaged") }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: t("companySkills.source.githubManaged") };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: t("companySkills.source.urlManaged") };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: t("companySkills.source.folderManaged") };
    case "paperclip":
      return { icon: Paperclip, label: sourceLabel ?? "Paperclip", managedLabel: t("companySkills.source.paperclipManaged") };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: t("companySkills.source.catalogManaged") };
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
    t("companySkills.scanSummary.found", { count: result.discovered }),
    t("companySkills.scanSummary.imported", { count: result.imported.length }),
    t("companySkills.scanSummary.updated", { count: result.updated.length }),
  ];
  if (result.conflicts.length > 0) parts.push(t("companySkills.scanSummary.conflicts", { count: result.conflicts.length }));
  if (result.skipped.length > 0) parts.push(t("companySkills.scanSummary.skipped", { count: result.skipped.length }));
  return t(
    result.scannedWorkspaces === 1
      ? "companySkills.scanSummary.across.single"
      : "companySkills.scanSummary.across.plural",
    { detail: parts.join(", "), count: result.scannedWorkspaces },
  );
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

const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = {
  all: t("companySkills.sourceFilter.all"),
  company: t("companySkills.sourceFilter.company"),
  bundled: t("companySkills.sourceFilter.bundled"),
  optional: t("companySkills.sourceFilter.optional"),
  external: t("companySkills.sourceFilter.external"),
};

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
  const filters: SourceFilter[] = ["all", "company", "bundled", "optional", "external"];
  const activeFilterCount = value === "all" ? 0 : 1;
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("relative shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? t("companySkills.filterMenu.filters", { count: activeFilterCount }) : t("companySkills.filterMenu.filter")}
        >
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t("companySkills.sourceFilterMenu.source")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as SourceFilter)}>
          {filters.map((filter) => (
            <DropdownMenuRadioItem key={filter} value={filter}>
              <span>{SOURCE_FILTER_LABELS[filter]}</span>
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
  const activeFilterCount = (kindFilter === "all" ? 0 : 1) + (categoryFilter ? 1 : 0);
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("relative shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? t("companySkills.filterMenu.filters", { count: activeFilterCount }) : t("companySkills.filterMenu.filter")}
        >
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-(--sz-calc-32) w-56 overflow-y-auto">
        <DropdownMenuLabel>{t("companySkills.catalogFilterMenu.type")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={kindFilter} onValueChange={(next) => onKindChange(next as "all" | "bundled" | "optional")}>
          <DropdownMenuRadioItem value="all">{t("companySkills.all")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bundled">{t("companySkills.bundled")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="optional">{t("companySkills.optional")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("companySkills.catalogFilterMenu.category")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={categoryFilter || "__all__"} onValueChange={(next) => onCategoryChange(next === "__all__" ? "" : next)}>
          <DropdownMenuRadioItem value="__all__">{t("companySkills.allCategories")}</DropdownMenuRadioItem>
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
      label: t("companySkills.trust.markdownOnly"),
      tooltip: t("companySkills.trust.markdownOnlyTooltip"),
      className: "border-border bg-muted/40 text-muted-foreground",
    },
    assets: {
      icon: Folder,
      label: t("companySkills.trust.assets"),
      tooltip: t("companySkills.trust.assetsTooltip"),
      className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
    },
    scripts_executables: {
      icon: AlertTriangle,
      label: t("companySkills.trust.scripts"),
      tooltip: t("companySkills.trust.scriptsTooltip"),
      className: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
    },
  } as const;
  const config = map[level] ?? map.markdown_only;
  const Icon = config.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("text-(length:--text-micro)", config.className)}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {config.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function CompatChip({ compatibility }: { compatibility: CompanySkillCompatibility }) {
  if (compatibility === "compatible") return null;
  const { t } = useTranslation();
  const map = {
    unknown: {
      icon: HelpCircle,
      label: t("companySkills.compat.unknownFormat"),
      tooltip: t("companySkills.compat.unknownFormatTooltip"),
      className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-800 dark:text-yellow-200",
    },
    invalid: {
      icon: XOctagon,
      label: t("companySkills.compat.invalid"),
      tooltip: t("companySkills.compat.invalidTooltip"),
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    },
  } as const;
  const config = map[compatibility];
  const Icon = config.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("text-(length:--text-micro)", config.className)}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {config.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ProvenanceBadge({ packageName, packageVersion }: { packageName: string | null; packageVersion: string | null }) {
  if (!packageName) return null;
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
          <Boxes className="h-3 w-3" aria-hidden="true" />
          <span>{packageName}{packageVersion ? ` v${packageVersion}` : ""}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("companySkills.provenance.tooltip")}</TooltipContent>
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

export type DiscoveryTab = "all" | "installed" | "catalog" | "bundled";

const DISCOVERY_TABS: DiscoveryTab[] = ["all", "installed", "catalog", "bundled"];

export function resolveDiscoveryTab(tabParam: string | null): DiscoveryTab {
  return DISCOVERY_TABS.includes(tabParam as DiscoveryTab)
    ? (tabParam as DiscoveryTab)
    : "installed";
}

export function withDiscoveryTab(current: URLSearchParams, tab: DiscoveryTab): URLSearchParams {
  const params = new URLSearchParams(current);
  if (tab === "installed") params.delete("tab");
  else params.set("tab", tab);
  params.delete("category");
  if (tab !== "installed") params.delete("folder");
  return params;
}

export function skillDetailBreadcrumbs(
  detail: Pick<CompanySkillDetail, "name" | "folderId">,
  folderResult: FolderListResult | null | undefined,
): Breadcrumb[] {
  const trail = detail.folderId
    ? folderBreadcrumbTrail(treeFromResult(folderResult), detail.folderId)
    : [];
  return [
    { label: t("companySkills.skillsBreadcrumb"), href: "/skills" },
    ...trail.map((folder, index) => ({
      label: index === 0 ? reservedRootLabel(folder) : folder.name,
      href: `/skills?folder=${encodeURIComponent(folder.id)}`,
    })),
    { label: detail.name },
  ];
}

type DiscoverySort = "agents" | "stars" | "forks" | "recent" | "alphabetical";

const DISCOVERY_SORT_LABELS: Record<DiscoverySort, string> = {
  agents: t("companySkills.discoverySort.agents"),
  stars: t("companySkills.discoverySort.stars"),
  forks: t("companySkills.discoverySort.forks"),
  recent: t("companySkills.discoverySort.recent"),
  alphabetical: t("companySkills.discoverySort.alphabetical"),
};

const DISCOVERY_SORTS: DiscoverySort[] = ["agents", "stars", "forks", "recent", "alphabetical"];

export type DiscoveryCard = {
  key: string;
  skillId: string | null;
  folderId?: string | null;
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

export { SkillCardIcon } from "../components/SkillCardIcon";

function discoveryVersionLabel(skill: {
  packageVersion: string | null;
  sourceRef: string | null;
}, required: boolean): string | null {
  if (skill.packageVersion) return `v${skill.packageVersion}`;
  if (required) return t("companySkills.discovery.core");
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

function categorySetKey(categories: string[]) {
  return [...categories].sort().join(",");
}

function skillSettingsToastBody(skill: Pick<CompanySkillDetail, "categories" | "sharingScope">) {
  const sharing = skill.sharingScope === "private"
    ? t("companySkills.settingsToast.sharingPrivate")
    : t("companySkills.settingsToast.sharingCompany");
  const categories = skill.categories.length
    ? t("companySkills.settingsToast.categories", { list: skill.categories.join(", ") })
    : t("companySkills.settingsToast.categoriesNone");
  return `${sharing} | ${categories}`;
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
      folderId: skill.folderId ?? null,
      catalogRef: catalogMatch ? catalogMatch.id : null,
      name: skill.name,
      slug: skill.slug,
      author: skill.authorName ?? skill.sourceLabel ?? "you",
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
      folderId: null,
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
    <Badge variant="outline" className="border-border bg-muted/40 text-(length:--text-nano) capitalize text-muted-foreground">
      {label}
    </Badge>
  );
}

function SkillCard({
  card,
  folders,
  selected = false,
  selectMode = false,
  showFolderBadge = false,
  onOpen,
  onSelectChange,
  onMove,
  onCreateFolderAndMove,
  onOpenMove,
}: {
  card: DiscoveryCard;
  folders?: FolderListItem[];
  selected?: boolean;
  selectMode?: boolean;
  /** Show the card's folder so search results reveal where an item lives (user story 5). */
  showFolderBadge?: boolean;
  onOpen: (card: DiscoveryCard) => void;
  onSelectChange?: (card: DiscoveryCard, selected: boolean) => void;
  onMove?: (card: DiscoveryCard, folderId: string | null) => void;
  onCreateFolderAndMove?: (card: DiscoveryCard) => void;
  onOpenMove?: (card: DiscoveryCard) => void;
}) {
  const { t } = useTranslation();
  const badgeFolder = showFolderBadge && card.installed
    ? (card.folderId ? folders?.find((folder) => folder.id === card.folderId) ?? null : null)
    : undefined;
  const cardFolder = card.folderId ? folders?.find((folder) => folder.id === card.folderId) ?? null : null;
  const canMove = card.installed
    && !card.required
    && !(cardFolder && isBundledFolder(cardFolder));
  return (
    <div
      onClick={() => onOpen(card)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(card);
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        // Quiet interactive-card affordance (DECISION-SHEET: one recipe for
        // clickable cards): pointer cursor, border darkens, slight lift.
        "group flex h-full min-h-(--sz-11_5rem) flex-col rounded-lg border border-border bg-card p-4 text-left cursor-pointer transition-colors hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        card.required && "bg-muted/30",
      )}
    >
      <div className="flex items-start gap-3">
        {selectMode && canMove ? (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border"
            checked={selected}
            aria-label={t("companySkills.card.select", { name: card.name })}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onSelectChange?.(card, event.target.checked)}
          />
        ) : null}
        <SkillCardIcon card={card} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-foreground">{card.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {t("companySkills.card.by", { author: card.author })}{card.version ? ` · ${card.version}` : ""}
          </div>
          {badgeFolder !== undefined ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <FolderSwatch color={badgeFolder?.color} className="h-2 w-2" />
              <span className="truncate">{badgeFolder ? badgeFolder.name : t("companySkills.unfiled")}</span>
            </div>
          ) : null}
        </div>
        {/* Where the skill came from (PAP-10907 E); native title gives a hover hint. */}
        {(() => {
          const meta = sourceMeta(card.sourceBadge ?? "catalog", card.sourceLabel ?? null);
          const SourceIcon = meta.icon;
          return (
            <span className="shrink-0 text-muted-foreground" title={t("companySkills.card.from", { label: meta.label })} aria-label={t("companySkills.card.from", { label: meta.label })}>
              <SourceIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          );
        })()}
        {canMove && folders && onMove && onCreateFolderAndMove ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-1 -mt-1 opacity-70 group-hover:opacity-100"
                aria-label={t("companySkills.card.moreActions", { name: card.name })}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              {onOpenMove ? (
                <>
                  <DropdownMenuItem onSelect={() => onOpenMove(card)}>
                    <FolderInput className="h-3.5 w-3.5" />
                    {t("companySkills.card.moveToFolder")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <MoveToMenu
                folders={folders}
                currentFolderId={card.folderId}
                onMove={(folderId) => onMove(card, folderId)}
                onCreateAndMove={() => onCreateFolderAndMove(card)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {card.forkedFrom ? (
        <div className="mt-2 inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
          <GitFork className="h-3 w-3" aria-hidden="true" />
          {t("companySkills.card.forked")}
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
        <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
          <span>{t(card.agentCount === 1 ? "companySkills.card.agentCount.single" : "companySkills.card.agentCount.plural", { count: card.agentCount })}</span>
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
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-(length:--text-nano) text-emerald-700 dark:text-emerald-300">
              {t("companySkills.card.installed")}
            </Badge>
          ) : null}
          {card.categories.slice(0, 2).map((category) => (
            <SkillCategoryChip key={category} label={category} />
          ))}
          {card.required ? (
            <Badge variant="outline" className="ml-auto border-border bg-muted/60 text-(length:--text-nano) text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden="true" />
              {t("companySkills.card.bundled")}
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
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
        <span>{t("companySkills.all")}</span>
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
  onImportFromProject,
  onBrowseCatalog,
  onScan,
  scanPending,
  scanStatus,
  folderResult,
  folderSelection = "all",
  foldersLoading = false,
  selectMode = false,
  selectedSkillIds = [],
  onFolderSelect,
  onCreateFolder,
  onRenameFolder,
  onEditFolder,
  onMoveFolder,
  onDeleteFolder,
  onToggleSelectMode,
  onSelectCard,
  onMoveCard,
  onCreateFolderAndMoveCard,
  onMoveSelected,
  onCreateFolderAndMoveSelected,
  onClearSelected,
  onOpenMobileFolders,
  onCreateFolderIn,
  onEnsureMyFolder,
  onOpenMoveCard,
  folderNudgeStorageKey,
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
  onImportFromProject: () => void;
  onBrowseCatalog: () => void;
  onScan: (projectId?: string) => void;
  scanPending: boolean;
  scanStatus: string | null;
  folderResult?: FolderListResult | null;
  folderSelection?: FolderSelection;
  foldersLoading?: boolean;
  selectMode?: boolean;
  selectedSkillIds?: string[];
  onFolderSelect?: (selection: FolderSelection) => void;
  onCreateFolder?: () => void;
  onRenameFolder?: (folder: FolderListItem, name: string) => void;
  onEditFolder?: (folder: FolderListItem) => void;
  onMoveFolder?: (folder: FolderListItem, destination: "my" | "company") => void;
  onDeleteFolder?: (folder: FolderListItem) => void;
  onToggleSelectMode?: () => void;
  onSelectCard?: (card: DiscoveryCard, selected: boolean) => void;
  onMoveCard?: (card: DiscoveryCard, folderId: string | null) => void;
  onCreateFolderAndMoveCard?: (card: DiscoveryCard) => void;
  onMoveSelected?: (folderId: string | null) => void;
  onCreateFolderAndMoveSelected?: () => void;
  onClearSelected?: () => void;
  onOpenMobileFolders?: () => void;
  /** Create a folder under `parentId` (null = top level), used by the tree rail. */
  onCreateFolderIn?: (parentId: string | null) => void;
  /** Provision the caller's personal "My Skills" root on demand. */
  onEnsureMyFolder?: () => void;
  /** Open the rich move-to-folder dialog for a single card. */
  onOpenMoveCard?: (card: DiscoveryCard) => void;
  /** When set and no folders exist yet, show the dismissible all-unfiled nudge (ux-spec §6.3). */
  folderNudgeStorageKey?: string;
}) {
  // Source filter (github / skills.sh / local / …) lives in the grid so it
  // narrows whatever the parent already filtered by tab/category/search (PAP-10907 E).
  const { t } = useTranslation();
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
  const folderActionsReady = Boolean(
    onCreateFolderIn && onRenameFolder && onEditFolder && onMoveFolder && onDeleteFolder,
  );
  // The nested folder tree owns the left rail whenever folders (reserved roots
  // or user folders) exist for the installed view.
  const showFolderRail = Boolean(
    folderResult && folderResult.folders.length > 0 && onFolderSelect && folderActionsReady,
  );
  const activeProjectFolder = useMemo(() => {
    if (!folderResult || folderSelection === "all" || folderSelection === "unfiled") return null;
    const folder = folderResult.folders.find((candidate) => candidate.id === folderSelection);
    return folder?.systemKey?.startsWith("project:") ? folder : null;
  }, [folderResult, folderSelection]);
  const activeProjectId = activeProjectFolder?.systemKey?.slice("project:".length) || null;

  return (
    // On desktop the store is bounded to the viewport so the category sidebar
    // and the results pane each scroll independently (PAP-10907). Mobile keeps
    // the natural page flow.
    <div className="flex min-h-(--sz-calc-30) md:h-(--sz-calc-33) md:min-h-0 md:overflow-hidden">
      {showFolderRail ? (
        <div className="hidden shrink-0 pl-4 pt-4 md:block">
          <SkillFolderRail
            result={folderResult}
            selection={folderSelection}
            loading={foldersLoading}
            tags={categories}
            activeTag={activeCategory}
            onSelect={onFolderSelect!}
            onSelectTag={onCategoryChange}
            onCreateFolder={onCreateFolderIn!}
            onRenameFolder={onRenameFolder!}
            onEditFolder={onEditFolder!}
            onMoveFolder={onMoveFolder!}
            onDeleteFolder={onDeleteFolder!}
            onEnsureMyFolder={onEnsureMyFolder}
          />
        </div>
      ) : null}
      {/* Secondary category sidebar — the main app nav collapses to a rail while
          this is present (handled in Layout). */}
      <aside className={cn("hidden w-60 shrink-0 flex-col overflow-hidden border-r border-border md:flex", showFolderRail && "md:hidden")}>
        <div className="border-b border-border px-4 py-4">
          <h2 className="text-sm font-semibold text-foreground">{t("companySkills.store.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("companySkills.store.subtitle")}</p>
        </div>
        <div className="px-4 pb-1 pt-3 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
          {t("companySkills.store.categories")}
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
          <div className="flex h-9 min-w-(--sz-12rem) flex-1 items-center gap-2 rounded-md border border-border px-2.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t("companySkills.searchPlaceholder")}
              className="h-full w-full bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <span className="text-muted-foreground">{t("companySkills.sort")}</span>
                <span className="ml-1.5">{DISCOVERY_SORT_LABELS[sort]}</span>
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as DiscoverySort)}>
                {DISCOVERY_SORTS.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {DISCOVERY_SORT_LABELS[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {availableSources.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <span className="text-muted-foreground">{t("companySkills.sourceLabel")}</span>
                  <span className="ml-1.5 capitalize">
                    {sourceBadgeFilter === "all" ? t("companySkills.all") : sourceMeta(sourceBadgeFilter as CompanySkillSourceBadge, null).label}
                  </span>
                  <ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={sourceBadgeFilter} onValueChange={setSourceBadgeFilter}>
                  <DropdownMenuRadioItem value="all">{t("companySkills.allSources")}</DropdownMenuRadioItem>
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
            onClick={() => onScan()}
            disabled={scanPending}
            aria-label={t("companySkills.scanProjectSkills")}
            title={t("companySkills.scanProjectSkills")}
          >
            <RefreshCw className={cn("h-4 w-4", scanPending && "animate-spin")} />
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/skills/studio">
              <FlaskConical className="h-3.5 w-3.5" />
              {t("companySkills.studio")}
            </Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="default">
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("companySkills.new")}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onCreate}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("companySkills.createNewSkill")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onBrowseCatalog}>
                <Boxes className="mr-2 h-4 w-4" />
                {t("companySkills.browseCatalog")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onImport}>
                <Globe className="mr-2 h-4 w-4" />
                {t("companySkills.importFromPathOrUrl")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onImportFromProject}>
                <FolderSearch className="mr-2 h-4 w-4" />
                {t("companySkills.importFromProject")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {folderResult && onFolderSelect ? (
            <div className="w-full md:hidden">
              <FolderChip
                result={folderResult}
                selection={folderSelection}
                allLabel={t("companySkills.allSkills")}
                onClick={onOpenMobileFolders ?? (() => undefined)}
              />
            </div>
          ) : null}
          {onCreateFolder && !showFolderRail ? (
            <Button variant="outline" size="sm" onClick={onCreateFolder}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("companySkills.newFolder")}
            </Button>
          ) : null}
          {onToggleSelectMode ? (
            <Button variant="ghost" size="sm" onClick={onToggleSelectMode}>
              {selectMode ? t("companySkills.done") : t("companySkills.select")}
            </Button>
          ) : null}
        </div>

        {/* Mobile category selector (sidebar is hidden below md) */}
        {categories.length > 0 ? (
          <div className="border-b border-border px-4 py-2 md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full justify-between">
                  <span className="capitalize">{activeCategory ?? t("companySkills.allCategories")}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
                <DropdownMenuRadioGroup
                  value={activeCategory ?? "__all__"}
                  onValueChange={(value) => onCategoryChange(value === "__all__" ? null : value)}
                >
                  <DropdownMenuRadioItem value="__all__">{t("companySkills.allWithCount", { count: categoryTotal })}</DropdownMenuRadioItem>
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
                <span>{t("companySkills.tabs.all")}</span>
                <span className="ml-1.5 text-(length:--text-micro) text-muted-foreground">{tabCounts.all}</span>
              </TabsTrigger>
              <TabsTrigger value="installed" className="px-3">
                <span>{t("companySkills.tabs.installed")}</span>
                <span className="ml-1.5 text-(length:--text-micro) text-muted-foreground">{tabCounts.installed}</span>
              </TabsTrigger>
              <TabsTrigger value="catalog" className="px-3">
                <span>{t("companySkills.tabs.catalog")}</span>
                <span className="ml-1.5 text-(length:--text-micro) text-muted-foreground">{tabCounts.catalog}</span>
              </TabsTrigger>
              <TabsTrigger value="bundled" className="px-3">
                <span>{t("companySkills.tabs.bundled")}</span>
                <span className="ml-1.5 text-(length:--text-micro) text-muted-foreground">{tabCounts.bundled}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Grid body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {scanStatus ? <p className="mb-3 text-xs text-muted-foreground">{scanStatus}</p> : null}
          {showFolderRail && onFolderSelect ? (
            <div className="mb-4 flex items-center justify-between gap-2">
              <FolderBreadcrumb result={folderResult} selection={folderSelection} onSelect={onFolderSelect} />
              {activeProjectFolder && activeProjectId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onScan(activeProjectId)}
                  disabled={scanPending}
                  aria-label={t("companySkills.refreshProjectSkills", { name: activeProjectFolder.name })}
                  title={t("companySkills.refreshSkillsFrom", { name: activeProjectFolder.name })}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", scanPending && "animate-spin")} />
                  {t("companySkills.refresh")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {folderNudgeStorageKey && onCreateFolder && folderResult && folderResult.folders.length === 0 && !loading && cards.length > 0 ? (
            <AllUnfiledBanner
              storageKey={folderNudgeStorageKey}
              itemLabelPlural={t("companySkills.itemLabelPlural")}
              onCreateFolder={onCreateFolder}
            />
          ) : null}
          {selectMode && onMoveSelected && onCreateFolderAndMoveSelected && onClearSelected ? (
            <div className="mb-3">
              <BulkBar
                selectedCount={selectedSkillIds.length}
                folders={folderResult?.folders ?? []}
                onMove={onMoveSelected}
                onCreateAndMove={onCreateFolderAndMoveSelected}
                onClear={onClearSelected}
                onDone={onToggleSelectMode ?? onClearSelected}
              />
            </div>
          ) : null}
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
                    ? t("companySkills.empty.noSkillsYet")
                    : search || activeCategory || sourceFilterActive
                      ? t("companySkills.empty.noMatchFilters")
                      : t("companySkills.empty.noSkillsInTab")
                }
              />
              {totalCount === 0 ? (
                <div className="mt-3 flex flex-col items-center gap-2">
                  <Button size="sm" onClick={onBrowseCatalog}>
                    <Boxes className="mr-1.5 h-3.5 w-3.5" /> {t("companySkills.browseCatalog")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onCreate}>
                    {t("companySkills.createASkill")}
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
                    {t("companySkills.clearFilters")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                {t(sourceFilteredCards.length === 1 ? "companySkills.count.skill.single" : "companySkills.count.skill.plural", { count: sourceFilteredCards.length })}
                {activeCategory ? <span className="capitalize"> · {activeCategory}</span> : null}
              </p>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
                {sourceFilteredCards.map((card) => (
                  <SkillCard
                    key={card.key}
                    card={card}
                    folders={folderResult?.folders}
                    selected={selectedSkillIds.includes(card.skillId ?? "")}
                    selectMode={selectMode}
                    showFolderBadge={Boolean(folderResult && search.trim())}
                    onOpen={onOpenCard}
                    onSelectChange={onSelectCard}
                    onMove={onMoveCard}
                    onCreateFolderAndMove={onCreateFolderAndMoveCard}
                    onOpenMove={onOpenMoveCard}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
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
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SkillCreateDraft>(initialDraft);
  const [slugDirty, setSlugDirty] = useState(initialDraft.slug.trim().length > 0);
  const { t } = useTranslation();
  const categoryDraft = draft.categories.join(", ");
  const steps = [
    t("companySkills.wizard.steps.basics"),
    t("companySkills.wizard.steps.design"),
    t("companySkills.wizard.steps.content"),
    t("companySkills.wizard.steps.review"),
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
  function submit() {
    onCreate(skillCreateDraftToPayload(draft));
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
          {t("companySkills.wizard.forking", { name: draft.forkedFromName })}
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
            placeholder={t("companySkills.wizard.skillNamePlaceholder")}
            className="h-9"
          />
          <Input
            value={draft.slug}
            onChange={(event) => {
              const nextSlug = normalizeSkillDraftSlug(event.target.value);
              setSlugDirty(nextSlug.length > 0);
              patchDraft({ slug: nextSlug });
            }}
            placeholder={t("companySkills.wizard.slugPlaceholder")}
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
            placeholder={t("companySkills.wizard.taglinePlaceholder")}
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
                name: draft.name || "New Skill",
                slug: effectiveSlug || "skill",
                iconUrl: null,
                color: draft.color,
              }}
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{draft.name || t("companySkills.wizard.newSkill")}</div>
              <div className="truncate text-xs text-muted-foreground">{draft.tagline || t("companySkills.noTaglineYet")}</div>
            </div>
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.wizard.color")}</label>
            <div className="flex flex-wrap gap-2">
              {SKILL_CREATE_ACCENTS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => patchDraft({ color })}
                  className={cn(
                    "h-7 w-7 rounded-md border",
                    draft.color === color ? "border-foreground" : "border-border",
                  )}
                  style={{ backgroundColor: color }}
                  aria-label={t("companySkills.wizard.useColor", { color })}
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
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.wizard.categories")}</label>
            <Input
              value={categoryDraft}
              onChange={(event) => patchDraft({ categories: splitCategoryDraft(event.target.value) })}
              placeholder={t("companySkills.categoriesPlaceholder")}
              className="h-9"
            />
          </div>
        </div>
      ) : step === 2 ? (
        <div className="space-y-2">
          <Textarea
            value={draft.markdown}
            onChange={(event) => patchDraft({ markdown: event.target.value })}
            className="h-(--sz-calc-34) resize-y font-mono text-xs"
          />
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-(--gtc-26) gap-y-2">
            <span className="text-muted-foreground">{t("companySkills.wizard.name")}</span>
            <span>{draft.name || t("companySkills.wizard.untitled")}</span>
            <span className="text-muted-foreground">{t("companySkills.wizard.slug")}</span>
            <span className="font-mono">{effectiveSlug || "skill"}</span>
            <span className="text-muted-foreground">{t("companySkills.wizard.scope")}</span>
            <span>{draft.sharingScope === "private" ? t("companySkills.private") : t("companySkills.company")}</span>
            <span className="text-muted-foreground">{t("companySkills.wizard.categories")}</span>
            <span>{draft.categories.length ? draft.categories.join(", ") : t("companySkills.none")}</span>
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.wizard.sharing")}</label>
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
                  <span className="block font-medium">{scope === "company" ? t("companySkills.company") : t("companySkills.private")}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {scope === "company" ? t("companySkills.visibleInCompany") : t("companySkills.onlyVisibleInLibrary")}
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled
                className="rounded-md border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground"
              >
                <span className="block font-medium">{t("companySkills.publicLink")}</span>
                <span className="mt-1 block text-xs">{t("companySkills.comingLater")}</span>
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
          {t("companySkills.cancel")}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={isPending || step === 0}>
            {t("companySkills.back")}
          </Button>
          {step < steps.length - 1 ? (
            <Button size="sm" onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))} disabled={!nameValid}>
              {t("companySkills.next")}
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={isPending || !nameValid}>
              {isPending ? t("companySkills.creating") : draft.forkedFromSkillId ? t("companySkills.createFork") : t("companySkills.createSkill")}
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
        {t("companySkills.catalogList.noMatch")}
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
            "group grid grid-cols-(--gtc-3) items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
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
              <span className="min-w-0 overflow-hidden text-(length:--text-compact) font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                {skill.name}
              </span>
            </span>
          </Link>
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-(--tp-background-color-color-opacity) hover:bg-accent hover:text-foreground group-hover:opacity-100"
            onClick={() => onToggleSkill(skill.id)}
            aria-label={expanded ? t("companySkills.collapseSkill", { name: skill.name }) : t("companySkills.expandSkill", { name: skill.name })}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div
          aria-hidden={!expanded}
          className={cn(
            "grid overflow-hidden transition-(--tp-grid-template-rows-opacity) duration-200 ease-(--e-cubic-bezier-0_16-1-0_3-1)",
            expanded ? "grid-rows-(--gtr-2) opacity-100" : "grid-rows-(--gtr-3) opacity-0",
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
            {t("companySkills.catalogList.bundled", { count: bundled.length })}
          </div>
          {bundled.map(renderRow)}
        </div>
      ) : null}
      {optional.length > 0 && kindFilter !== "bundled" ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("companySkills.catalogList.optional", { count: optional.length })}
          </div>
          {optional.map(renderRow)}
        </div>
      ) : null}
      {installed.length > 0 ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("companySkills.catalogList.installed", { count: installed.length })}
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
    return <EmptyState icon={Boxes} message={t("companySkills.catalogDetail.selectSkillToInspect")} />;
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
              {t("companySkills.catalogDetail.installSkill")}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("companySkills.compat.invalidTooltip")}</TooltipContent>
      </Tooltip>
    );
  } else if (!isInstalled) {
    cta = (
      <Button onClick={onInstall} disabled={loadingPrimaryAction}>
        {skill.trustLevel === "scripts_executables" ? <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
        {loadingPrimaryAction ? t("companySkills.catalogDetail.preparing") : t("companySkills.catalogDetail.installInOrg")}
      </Button>
    );
  } else if (hashOutOfSync) {
    cta = (
      <Button onClick={onUpdate} disabled={loadingPrimaryAction} className="border-amber-500/40 bg-amber-500/20 text-amber-900 dark:text-amber-100 hover:bg-amber-500/30">
        <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
        {t("companySkills.catalogDetail.updateFromCatalog")}
      </Button>
    );
  } else {
    cta = (
      <Button variant="ghost" onClick={() => installedSkillId && onOpenInstalled(installedSkillId)}>
        <Check className="mr-1.5 h-3.5 w-3.5" />
        {t("companySkills.catalogDetail.installedOpenInLibrary")}
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
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-(length:--text-micro) text-amber-800 dark:text-amber-200">
                  <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                  {t("companySkills.catalogDetail.updateAvailable")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t("companySkills.catalogDetail.updateAvailableTooltip")}</TooltipContent>
            </Tooltip>
          ) : null}
          {skill.requires.length > 0 ? (
            <Badge variant="outline" className="border-border bg-muted/40 text-(length:--text-micro) text-muted-foreground">
              {t("companySkills.catalogDetail.requires", { list: skill.requires.join(", ") })}
            </Badge>
          ) : null}
          {skill.recommendedForRoles.length > 0 ? (
            <Badge variant="outline" className="border-border bg-muted/40 text-(length:--text-micro) text-muted-foreground">
              {t("companySkills.catalogDetail.roles", { list: skill.recommendedForRoles.join(" · ") })}
            </Badge>
          ) : null}
          {skill.tags.length > 0 ? (
            <Badge variant="outline" className="border-border bg-muted/40 text-(length:--text-micro) text-muted-foreground">
              {t("companySkills.catalogDetail.tags", { list: skill.tags.join(" · ") })}
            </Badge>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="uppercase tracking-(--tracking-caps)">{t("companySkills.key")}</span>
          <span className="font-mono">{skill.key}</span>
          <span className="uppercase tracking-(--tracking-caps)">·</span>
          <span className="uppercase tracking-(--tracking-caps)">{t("companySkills.hash")}</span>
          <span className="font-mono">{skill.contentHash.slice(0, 24)}…</span>
          <CopyText
            text={skill.contentHash}
            copiedLabel={t("companySkills.copiedHash")}
            ariaLabel={t("companySkills.copyContentHash")}
            title={t("companySkills.copyContentHash")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </CopyText>
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <div className="truncate font-mono text-sm">{selectedPath}</div>
      </div>

      <div className="min-h-(--sz-400px) px-5 py-5">
        {fileQuery.isLoading ? (
          <PageSkeleton variant="detail" />
        ) : fileQuery.error ? (
          <div className="text-sm text-destructive">{fileQuery.error instanceof Error ? fileQuery.error.message : t("companySkills.failedToLoadFile")}</div>
        ) : !fileQuery.data ? (
          <div className="text-sm text-muted-foreground">{t("companySkills.selectFileToInspect")}</div>
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
  const [slug, setSlug] = useState<string>("");
  const [force, setForce] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    setSlug(defaultSlug ?? "");
    setForce(defaultForce);
    setAdvancedOpen(defaultAction === "replace" || defaultForce);
  }, [open, defaultSlug, defaultForce, defaultAction]);

  if (!skill) return null;

  let confirmLabel = t("companySkills.installDialog.installSkill");
  let confirmVariant: "default" | "destructive" = "default";
  if (defaultAction === "update") {
    confirmLabel = t("companySkills.installDialog.installUpdate");
  } else if (defaultAction === "replace") {
    confirmLabel = t("companySkills.installDialog.replaceExisting");
    confirmVariant = "destructive";
  }
  if (isPending) confirmLabel = t("companySkills.installDialog.installing");

  return (
    <Dialog open={open} onOpenChange={(value) => (!isPending ? onOpenChange(value) : null)}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>
            {t(defaultAction === "update" ? "companySkills.installDialog.update" : defaultAction === "replace" ? "companySkills.installDialog.replace" : "companySkills.installDialog.install", { name: skill.name })}
          </DialogTitle>
          <DialogDescription>
            <span className="capitalize">{skill.kind}</span> · {skill.category}
            {packageName ? <> · {packageName}{packageVersion ? ` v${packageVersion}` : ""}</> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-border p-3">
            <div className="grid grid-cols-(--gtc-26) gap-y-2 text-xs">
              <div className="text-muted-foreground">{t("companySkills.installDialog.trust")}</div>
              <div className="flex items-center gap-2">
                <TrustChip level={skill.trustLevel} />
                {skill.trustLevel === "markdown_only" ? (
                  <span className="text-muted-foreground">{t("companySkills.installDialog.safe")}</span>
                ) : skill.trustLevel === "scripts_executables" ? (
                  <span className="text-amber-800 dark:text-amber-200">{t("companySkills.installDialog.reviewRequired")}</span>
                ) : (
                  <span className="text-muted-foreground">{t("companySkills.installDialog.nonScriptAssets")}</span>
                )}
              </div>
              <div className="text-muted-foreground">{t("companySkills.installDialog.compatibility")}</div>
              <div className="flex items-center gap-2">
                {skill.compatibility === "compatible" ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {t("companySkills.installDialog.compatible")}
                  </span>
                ) : (
                  <CompatChip compatibility={skill.compatibility} />
                )}
              </div>
              <div className="text-muted-foreground">{t("companySkills.installDialog.requires")}</div>
              <div className="text-foreground">{skill.requires.length === 0 ? t("companySkills.none") : skill.requires.join(", ")}</div>
              <div className="text-muted-foreground">{t("companySkills.installDialog.roles")}</div>
              <div className="text-foreground">{skill.recommendedForRoles.length === 0 ? t("companySkills.any") : skill.recommendedForRoles.join(" · ")}</div>
              <div className="text-muted-foreground">{t("companySkills.installDialog.provenance")}</div>
              <div className="min-w-0">
                <div className="truncate">{packageName ?? "—"}{packageVersion ? ` v${packageVersion}` : ""}</div>
                <div className="truncate font-mono text-(length:--text-micro) text-muted-foreground">{skill.contentHash}</div>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              {t("companySkills.installDialog.files", { count: skill.files.length })}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {skill.files.map((file) => (
                <div key={file.path} className="grid grid-cols-(--gtc-27) items-center gap-x-3 border-b border-border/50 px-3 py-1.5 text-xs last:border-b-0">
                  <span className="truncate font-mono text-muted-foreground">{file.path}</span>
                  <span className="rounded border border-border bg-muted/40 px-1 py-0.5 text-(length:--text-nano) uppercase text-muted-foreground">{file.kind}</span>
                  <span className="text-(length:--text-micro) text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                </div>
              ))}
            </div>
          </div>

          {conflict ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
              {t("companySkills.installDialog.conflictPrefix")}
              <span className="font-mono">{conflict.key}</span>
              {t("companySkills.installDialog.conflictSuffix", { source: conflict.sourceLabel ?? conflict.sourceType })}
              {defaultAction === "update"
                ? t("companySkills.installDialog.conflictOverwrite")
                : t("companySkills.installDialog.conflictReplace")}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {t("companySkills.installDialog.advanced")}
          </button>
          {advancedOpen ? (
            <div className="space-y-3 rounded-md border border-border p-3 text-xs">
              <div>
                <label className="mb-1 block uppercase tracking-wide text-muted-foreground">{t("companySkills.installDialog.slugOverride")}</label>
                <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={defaultSlug ?? skill.slug} className="h-8" />
              </div>
              <label className="flex items-center gap-2">
                <Checkbox checked={force} onCheckedChange={(value) => setForce(Boolean(value))} />
                <span>{t("companySkills.installDialog.forceReplace")}</span>
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
            {t("companySkills.cancel")}
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
  const [draftVersionId, setDraftVersionId] = useState<string | null>(selectedVersionId);
  const attachedIds = useMemo(() => new Set(attachedAgentIds), [attachedAgentIds]);
  const eligible = agents.filter((agent) => agent.supportsSkills);
  const sortedVersions = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const { t } = useTranslation();

  return (
    <AgentMultiSelect
      agents={agents}
      selectedAgentIds={attachedIds}
      onSave={(nextIds) => onSubmit(Array.from(nextIds), draftVersionId)}
      pending={pending}
      triggerLabel={t("companySkills.attachAgents.addToAgent")}
      triggerIcon={<Plus className="mr-1.5 h-3.5 w-3.5" />}
      triggerVariant="default"
      triggerSize="sm"
      triggerFullWidth={fullWidth}
      triggerClassName={cn(fullWidth && "w-full")}
      contentAlign="end"
      showSelectionPreview={false}
      onOpenChange={(open) => {
        if (open) setDraftVersionId(selectedVersionId);
      }}
      headerContent={sortedVersions.length > 0 ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">{t("companySkills.attachAgents.version")}</span>
          <select
            value={draftVersionId ?? "__latest__"}
            onChange={(event) => setDraftVersionId(event.target.value === "__latest__" ? null : event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            <option value="__latest__">{t("companySkills.attachAgents.latest")}</option>
            {sortedVersions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.revisionNumber}{version.label ? ` · ${version.label}` : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      emptyMessage={eligible.length === 0 ? t("companySkills.attachAgents.noSupportingAgents") : t("companySkills.attachAgents.noAgents")}
      isAgentDisabled={(agent) => {
        const option = agent as AttachAgentOption;
        return option.required || !option.supportsSkills;
      }}
      getDescription={(agent) => {
        const option = agent as AttachAgentOption;
        return [
          option.adapterType,
          ...(option.required ? [t("companySkills.attachAgents.required")] : []),
          ...(!option.supportsSkills ? [t("companySkills.attachAgents.skillsNotSupported")] : []),
        ].join(" · ");
      }}
      renderNameSuffix={(agent) => (agent as AttachAgentOption).paused ? (
        <Badge variant="outline" className="[&>svg]:size-2.5 border-amber-500/30 bg-amber-500/10 px-1.5 text-(length:--text-nano) uppercase tracking-wide text-amber-500">
          <Pause className="h-2.5 w-2.5" aria-hidden="true" />
          {t("companySkills.paused")}
        </Badge>
      ) : null}
    />
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
                  "group grid w-full grid-cols-(--gtc-3) items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
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
                  className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-(--tp-background-color-color-opacity) hover:bg-accent hover:text-foreground group-hover:opacity-100"
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
          {t("companySkills.skillList.noFilteredInstalled", { label: SOURCE_FILTER_LABELS[sourceFilter].toLowerCase() })}{" "}
          <button type="button" className="text-foreground underline" onClick={onClearFilters}>
            {t("companySkills.clearFilter")}
          </button>
        </div>
      );
    }
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {t("companySkills.skillList.noMatch")}
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
                "group grid grid-cols-(--gtc-3) items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
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
                  <span className="min-w-0 overflow-hidden text-(length:--text-compact) font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                    {skill.name}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-(--tp-background-color-color-opacity) hover:bg-accent hover:text-foreground group-hover:opacity-100"
                onClick={() => onToggleSkill(skill.id)}
                aria-label={expanded ? t("companySkills.collapseSkill", { name: skill.name }) : t("companySkills.expandSkill", { name: skill.name })}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div
              aria-hidden={!expanded}
              className={cn(
                "grid overflow-hidden transition-(--tp-grid-template-rows-opacity) duration-200 ease-(--e-cubic-bezier-0_16-1-0_3-1)",
                expanded ? "grid-rows-(--gtr-2) opacity-100" : "grid-rows-(--gtr-3) opacity-0",
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

const SKILL_DETAIL_TABS: Array<{ value: SkillDetailTab; label: string; icon: typeof FileText }> = [
  { value: "overview", label: t("companySkills.detailTabs.overview"), icon: FileText },
  { value: "files", label: t("companySkills.detailTabs.files"), icon: FolderOpen },
  { value: "versions", label: t("companySkills.detailTabs.versions"), icon: History },
  { value: "agents", label: t("companySkills.detailTabs.agents"), icon: Users },
];

function currentVersionSelection(detail: CompanySkillDetail | null | undefined) {
  const selected = detail?.usedByAgents.find((agent) => agent.versionId)?.versionId;
  return selected ?? null;
}

function versionLabel(version: CompanySkillVersion | null | undefined) {
  if (!version) return t("companySkills.version.latest");
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
  const sorted = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const left = sorted.find((version) => version.id === leftVersionId) ?? null;
  const right = sorted.find((version) => version.id === rightVersionId) ?? null;
  const { t } = useTranslation();
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
    removed: "bg-red-500/10 text-red-900 dark:text-red-100",
    added: "bg-green-500/10 text-green-900 dark:text-green-100",
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
      <DialogContent className="flex max-h-(--sz-85vh) w-full !max-w-(--pct-90) flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("companySkills.versionDiff.title")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <Badge variant="outline" className="border-red-500/30 bg-red-500/10 uppercase tracking-wider text-red-400">{t("companySkills.versionDiff.old")}</Badge>
              <select
                value={leftVersionId ?? ""}
                onChange={(event) => onLeftVersionChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="">{t("companySkills.versionDiff.initial")}</option>
                {sorted.map((version) => (
                  <option key={version.id} value={version.id}>{versionLabel(version)}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <Badge variant="outline" className="border-green-500/30 bg-green-500/10 uppercase tracking-wider text-green-400">{t("companySkills.versionDiff.new")}</Badge>
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
              <div className="p-6 text-center text-sm text-muted-foreground">{t("companySkills.versionDiff.selectVersion")}</div>
            ) : left?.id === right.id ? (
              <div className="p-6 text-center text-sm text-muted-foreground">{t("companySkills.versionDiff.sameVersion")}</div>
            ) : (
              <div className="font-mono text-xs leading-6">
                <div className="grid grid-cols-(--gtc-1) border-b border-border/60 bg-muted/30 px-3 py-2 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                  <span>{t("companySkills.versionDiff.old")}</span>
                  <span>{t("companySkills.versionDiff.new")}</span>
                  <span />
                  <span>{effectivePath}</span>
                </div>
                {diffRows.map((row, index) => (
                  <div
                    key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                    className={cn("grid grid-cols-(--gtc-1) gap-0 border-b border-border/30 px-3", lineClassesByKind[row.kind])}
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

/**
 * Canonical-path block for the skill detail (wireframe screen 5): the folder
 * location is a first-class element with Copy and Move actions. The `skill://`
 * link and skill id survive folder moves, so the path is presentational.
 */
function SkillLocationCard({
  folderPath,
  onMove,
}: {
  folderPath: string | null | undefined;
  onMove?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();
  const canonical = folderPath && folderPath.length > 0 ? folderPath : t("companySkills.unfiled");
  return (
    <section>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.location")}</div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={canonical}>{canonical}</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyTextToClipboard(canonical)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {});
          }}
        >
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          {copied ? t("companySkills.copied") : t("companySkills.copyPath")}
        </Button>
        {onMove ? (
          <Button size="sm" variant="outline" onClick={onMove}>
            <FolderInput className="mr-1.5 h-3.5 w-3.5" />
            {t("companySkills.move")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Inline tags editor for the skill detail. Tags are the skill's `categories[]`
 * presented as first-class chips — there is no separate "tags" field.
 */
function SkillTagsEditor({
  categories,
  pending,
  onSave,
}: {
  categories: string[];
  pending: boolean;
  onSave: (categories: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const { t } = useTranslation();
  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase();
    if (!tag || categories.includes(tag)) {
      setDraft("");
      return;
    }
    onSave([...categories, tag]);
    setDraft("");
  }
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Hash className="h-3 w-3" />
        {t("companySkills.tagsEditor.tags")}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {categories.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-accent/40 px-2 py-0.5 text-xs text-foreground"
          >
            {tag}
            <button
              type="button"
              aria-label={t("companySkills.tagsEditor.removeTag", { tag })}
              disabled={pending}
              onClick={() => onSave(categories.filter((entry) => entry !== tag))}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {categories.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("companySkills.tagsEditor.noTags")}</span>
        ) : null}
      </div>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addTag(draft);
          }
        }}
        onBlur={() => draft.trim() && addTag(draft)}
        placeholder={t("companySkills.tagsEditor.addTag")}
        disabled={pending}
        className="mt-2 h-8 text-sm"
      />
    </section>
  );
}

export function SkillDetailPage({
  detail,
  folderDisplayPath,
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
  onUpdateSettings,
  updateSettingsPending,
  onMoveToFolder,
  onDelete,
  deletePending,
  studioHref,
}: {
  detail: CompanySkillDetail | null | undefined;
  folderDisplayPath?: string | null;
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
  onUpdateSettings: (payload: Pick<CompanySkillUpdateRequest, "categories" | "sharingScope">) => void;
  updateSettingsPending: boolean;
  /** Open the rich move-to-folder dialog for this skill. */
  onMoveToFolder?: () => void;
  onDelete: () => void;
  deletePending: boolean;
  studioHref?: string;
}) {
  const { t } = useTranslation();
  const [diffOpen, setDiffOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSharingScope, setSettingsSharingScope] = useState<Exclude<CompanySkillSharingScope, "public_link">>("company");
  const [settingsCategoryDraft, setSettingsCategoryDraft] = useState("");
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
  useEffect(() => {
    if (!detail || settingsOpen) return;
    setSettingsSharingScope(detail.sharingScope === "public_link" ? "company" : detail.sharingScope);
    setSettingsCategoryDraft(detail.categories.join(", "));
  }, [detail, settingsOpen]);
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
    return loading ? <PageSkeleton variant="detail" /> : <EmptyState icon={Boxes} message={t("companySkills.skillNotFound")} />;
  }

  const skill = detail;
  const resolvedStudioHref = studioHref ?? skillStudioRoute(skill.id);
  const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
  const SourceIcon = source.icon;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(skill.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const selectedVersion = versions.find((version) => version.id === currentVersionSelection(skill)) ?? null;
  const subtitleText = resolveSkillSummaryText(skill) ?? source.label;
  const settingsCategories = splitCategoryDraft(settingsCategoryDraft);
  const settingsCategoriesDirty = categorySetKey(settingsCategories) !== categorySetKey(skill.categories);
  const settingsSharingDirty = settingsSharingScope !== (skill.sharingScope === "public_link" ? "company" : skill.sharingScope);
  const settingsDirty = settingsCategoriesDirty || settingsSharingDirty;
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
  // Fallback for non-catalog skills: the recorded locator/path wraps inside
  // the narrow sidebar instead of widening the page.
  const sourceLocatorText = skill.sourcePath || skill.sourceLocator || null;
  const sourceHref =
    skill.homepageUrl
    ?? (sourceLocatorText && /^(https?:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(sourceLocatorText)
      ? sourceLocatorText.startsWith("http")
        ? sourceLocatorText
        : `https://${sourceLocatorText}`
      : null);

  function renderFilesBody() {
    return (
      <div className="grid min-h-(--sz-560px) gap-0 lg:grid-cols-(--gtc-28)">
        <aside className="border-b border-border pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.files")}</div>
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
                    <span className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" /> {t("companySkills.view")}</span>
                  </button>
                  <button
                    className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" ? "text-foreground" : "text-muted-foreground")}
                    onClick={() => setViewMode("code")}
                  >
                    <span className="flex items-center gap-1.5"><Code2 className="h-3.5 w-3.5" /> {t("companySkills.code")}</span>
                  </button>
                </div>
              ) : null}
              {skill.editable && file?.editable ? (
                editMode ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>{t("companySkills.cancel")}</Button>
                    <Button size="sm" onClick={onSave} disabled={savePending}>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      {savePending ? t("companySkills.saving") : t("companySkills.save")}
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setEditMode(true)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t("companySkills.edit")}
                  </Button>
                )
              ) : !skill.editable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onFork}
                  title={skill.editableReason ?? t("companySkills.forkToEdit")}
                >
                  <GitFork className="mr-1.5 h-3.5 w-3.5" />
                  {t("companySkills.fork")}
                </Button>
              ) : null}
            </div>
          </div>
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : !file ? (
            <div className="text-sm text-muted-foreground">{t("companySkills.selectFileToInspect")}</div>
          ) : editMode && file.editable ? (
            file.markdown ? (
              <MarkdownEditor value={draft} onChange={setDraft} bordered={false} className="min-h-(--sz-520px)" />
            ) : (
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-(--sz-520px) rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
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
          <h2 className="mb-2 text-sm font-medium">{t("companySkills.detail.about")}</h2>
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : file?.markdown ? (
            <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body || skill.description || t("companySkills.noOverview")}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">{skill.description ?? t("companySkills.noOverview")}</p>
          )}
        </section>
        <section className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("companySkills.key")}</div>
            <div className="mt-1 truncate font-mono">{skill.key}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("companySkills.sourceLabel")}</div>
            <div className="mt-1 min-w-0 [overflow-wrap:anywhere]">{sourceLocatorText ?? source.label}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("companySkills.versionLabel")}</div>
            <div className="mt-1">{versionLabel(skill.currentVersion ?? null)}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">{t("companySkills.mode")}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {skill.editable ? (
                t("companySkills.editable")
              ) : (
                <>
                  <span>{t("companySkills.readOnly")}</span>
                  <Button type="button" variant="outline" size="xs" onClick={onFork}>
                    <GitFork className="mr-1 h-3 w-3" />
                    {t("companySkills.fork")}
                  </Button>
                </>
              )}
            </div>
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
            {versionsLoading ? t("companySkills.loadingVersions") : t(versions.length === 1 ? "companySkills.versions.count.single" : "companySkills.versions.count.plural", { count: versions.length })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openVersionDiff()}
            disabled={sortedVersions.length < 2}
          >
            <History className="mr-1.5 h-3.5 w-3.5" /> {t("companySkills.compare")}
          </Button>
        </div>
        <div className="border-y border-border">
          {versionsLoading ? (
            <PageSkeleton variant="list" />
          ) : sortedVersions.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">{t("companySkills.noSavedVersions")}</div>
          ) : (
            sortedVersions.map((version) => (
              <div key={version.id} className="grid gap-2 border-b border-border px-0 py-3 text-sm last:border-b-0 sm:grid-cols-(--gtc-13)">
                <div className="min-w-0">
                  <div className="font-medium">{versionLabel(version)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {relativeTime(version.createdAt)} · {t("companySkills.fileCount", { count: version.fileInventory.length })}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openVersionDiff(version.id)}
                >
                  {t("companySkills.viewDiff")}
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
            {t(attached.length === 1 ? "companySkills.agents.attached.single" : "companySkills.agents.attached.plural", { count: attached.length })}
            {selectedVersion ? ` · ${versionLabel(selectedVersion)}` : ` · ${t("companySkills.latest")}`}
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
            {t("companySkills.agents.noAgentsUsing")}
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
                        <Badge variant="outline" className="[&>svg]:size-2.5 border-amber-500/30 bg-amber-500/10 px-1.5 text-(length:--text-nano) uppercase tracking-wide text-amber-500">
                          <Pause className="h-2.5 w-2.5" aria-hidden="true" />
                          {t("companySkills.paused")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{agent.adapterType}</div>
                  </div>
                  <Link
                    to={`/agents/${agent.urlKey}/skills`}
                    className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground"
                  >
                    {t("companySkills.view")}
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
    <div className="min-h-(--sz-calc-30)">
      <div className="border-b border-border px-4 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-start gap-3">
              <SkillCardIcon
                card={{
                  key: detail.key,
                  name: detail.name,
                  slug: detail.slug,
                  iconUrl: detail.iconUrl,
                  color: detail.color,
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
                        aria-label={t("companySkills.installedFrom", { label: source.label })}
                      >
                        <SourceIcon className="h-4 w-4" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t("companySkills.installedFrom", { label: source.label })}</TooltipContent>
                  </Tooltip>
                </div>
                {/* GitHub-style "by" attribution sits directly under the title. */}
                {detail.authorName ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {t("companySkills.by", { author: detail.authorName })}
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
                        {descExpanded ? t("companySkills.showLess") : t("companySkills.viewAll")}
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
            <Button variant="outline" size="sm" asChild>
              <Link to={resolvedStudioHref}>
                <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
                {t("companySkills.openInStudio")}
              </Link>
            </Button>
            <div className="flex items-center overflow-hidden rounded-md border border-border">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="font-medium text-foreground">{detail.attachedAgentCount}</span>
                    <span className="hidden sm:inline">{t(detail.attachedAgentCount === 1 ? "companySkills.installs.single" : "companySkills.installs.plural")}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("companySkills.installsTooltip")}</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={onToggleStar}
                disabled={starPending}
                className="inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
                title={detail.starredByCurrentActor ? t("companySkills.unstar") : t("companySkills.star")}
              >
                <Star className={cn("h-3.5 w-3.5", detail.starredByCurrentActor && "fill-current text-yellow-400")} />
                <span className="hidden sm:inline">{detail.starredByCurrentActor ? t("companySkills.starred") : t("companySkills.star")}</span>
                <span className="font-medium text-foreground">{detail.starCount}</span>
              </button>
              <button
                type="button"
                onClick={onFork}
                className="inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                title={t("companySkills.forkThisSkill")}
              >
                <GitFork className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("companySkills.fork")}</span>
                <span className="font-medium text-foreground">{detail.forkCount}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 px-4 py-4 xl:grid-cols-(--gtc-29)">
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
                    {tab.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          {tabBody}
        </main>

        <aside className="min-w-0 space-y-6 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
          <SkillLocationCard
            folderPath={folderDisplayPath ?? skillFolderPathDisplayFallback(detail.folderPath)}
            onMove={onMoveToFolder}
          />
          <SkillTagsEditor
            categories={detail.categories}
            pending={updateSettingsPending}
            onSave={(categories) => onUpdateSettings({ categories, sharingScope: detail.sharingScope === "public_link" ? "company" : detail.sharingScope })}
          />
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.agentsLabel")}</div>
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
                <p className="text-xs text-muted-foreground">{t("companySkills.noAgentsAttachedYet")}</p>
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
                          <Pause className="h-3 w-3 shrink-0 text-amber-500" aria-label={t("companySkills.paused")} />
                        ) : null}
                      </Link>
                    );
                  })}
                  {detail.usedByAgents.length > 3 ? (
                    <p className="px-1.5 pt-0.5 text-xs text-muted-foreground">
                      {t("companySkills.andMore", { count: detail.usedByAgents.length - 3 })}
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
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.sourceLabel")}</div>
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
                    className="mt-0.5 flex max-w-full items-start gap-1 text-xs text-muted-foreground no-underline transition-colors [overflow-wrap:anywhere] hover:text-foreground"
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">{githubRepoText}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </a>
                  <div className="mt-0.5 truncate font-mono text-(length:--text-micro) text-muted-foreground" title={githubSource.commit}>
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
                  {sourceLocatorText ? (
                    sourceHref ? (
                      <a
                        href={sourceHref}
                        target="_blank"
                        rel="noreferrer"
                        title={sourceLocatorText ?? undefined}
                        className="mt-0.5 flex max-w-full items-start gap-1 text-xs text-muted-foreground no-underline transition-colors [overflow-wrap:anywhere] hover:text-foreground"
                      >
                        <span className="min-w-0 [overflow-wrap:anywhere]">{sourceLocatorText}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <div className="mt-0.5 min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={sourceLocatorText ?? undefined}>
                        {sourceLocatorText}
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
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.updates")}</div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pin className="h-3.5 w-3.5 shrink-0" aria-label={t("companySkills.pinnedRevision")} />
                    </TooltipTrigger>
                    <TooltipContent>{t("companySkills.pinnedRevision")}</TooltipContent>
                  </Tooltip>
                  <span className="truncate font-mono text-foreground">{currentPin ?? t("companySkills.untracked")}</span>
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={onCheckUpdates} disabled={checkUpdatesPending || updateStatusLoading}>
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  {t("companySkills.checkForUpdates")}
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate ? (
                  <Button size="sm" className="w-full" onClick={onInstallUpdate} disabled={installUpdatePending}>
                    <ArrowUpCircle className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    {t("companySkills.installUpdate")}{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                ) : updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading ? (
                  <p className="text-xs text-muted-foreground">{t("companySkills.upToDate")}</p>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Config lives behind a gear; sharing + danger zone open in a modal
              (PAP-10907 A). */}
          <section>
            <button
              type="button"
              onClick={() => {
                setSettingsSharingScope(detail.sharingScope === "public_link" ? "company" : detail.sharingScope);
                setSettingsCategoryDraft(detail.categories.join(", "));
                setSettingsOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            >
              <Settings className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t("companySkills.settings")}</span>
            </button>
          </section>
        </aside>
      </div>

      {/* Floating save bar: stays visible while a file edit is dirty so the
          unsaved state is obvious (PAP-10907 J). */}
      {isDirty ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
          <span className="text-sm text-muted-foreground">{t("companySkills.unsavedChanges")}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(savedFileContent);
              setEditMode(false);
            }}
            disabled={savePending}
          >
            {t("companySkills.discard")}
          </Button>
          <Button size="sm" onClick={onSave} disabled={savePending}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {savePending ? t("companySkills.savingEllipsis") : t("companySkills.saveChanges")}
          </Button>
        </div>
      ) : null}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companySkills.skillSettings")}</DialogTitle>
            <DialogDescription>{t("companySkills.skillSettingsDescription", { name: detail.name })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.categories")}</label>
              <Input
                value={settingsCategoryDraft}
                onChange={(event) => setSettingsCategoryDraft(event.target.value)}
                placeholder={t("companySkills.categoriesPlaceholder")}
                className="h-9"
                disabled={updateSettingsPending}
              />
              <p className="text-xs text-muted-foreground">{t("companySkills.categoriesHint")}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.sharing")}</label>
              <select
                value={settingsSharingScope}
                onChange={(event) => setSettingsSharingScope(event.target.value as Exclude<CompanySkillSharingScope, "public_link">)}
                disabled={updateSettingsPending}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="company">{t("companySkills.sharingCompanyOption")}</option>
                <option value="private">{t("companySkills.sharingPrivateOption")}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("companySkills.publicLinkComingLater")}</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSettingsSharingScope(skill.sharingScope === "public_link" ? "company" : skill.sharingScope);
                  setSettingsCategoryDraft(skill.categories.join(", "));
                }}
                disabled={!settingsDirty || updateSettingsPending}
              >
                {t("companySkills.reset")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => onUpdateSettings({ sharingScope: settingsSharingScope, categories: settingsCategories })}
                disabled={!settingsDirty || updateSettingsPending}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {updateSettingsPending ? t("companySkills.savingEllipsis") : t("companySkills.saveSettings")}
              </Button>
            </div>
            {detail.editable ? (
              <div className="rounded-md border border-destructive/40 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-destructive">{t("companySkills.dangerZone")}</div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="min-w-0 text-xs text-muted-foreground">{t("companySkills.removeFromLibrary")}</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    onClick={onDelete}
                    disabled={deletePending}
                    title={detail.usedByAgents.length > 0 ? t("companySkills.detachBeforeRemoving") : undefined}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {deletePending ? t("companySkills.removing") : t("companySkills.remove")}
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
        message={t("companySkills.skillPane.selectSkillToInspect")}
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
    ? t("companySkills.detachBeforeRemoving")
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
            <Button variant="outline" size="sm" asChild>
              <Link to={skillStudioRoute(detail.id)}>
                <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
                {t("companySkills.openInStudio")}
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={deletePending}
              title={removeDisabledReason ?? undefined}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {deletePending ? t("companySkills.removing") : t("companySkills.remove")}
            </Button>
            {detail.editable ? (
              <button
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setEditMode(!editMode)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode ? t("companySkills.stopEditing") : t("companySkills.edit")}
              </button>
            ) : (
              <div className="text-sm text-muted-foreground">{detail.editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("companySkills.sourceLabel")}</span>
              <span className="flex min-w-0 items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {detail.sourcePath && displaySourcePath ? (
                  <>
                    <span
                      className="block min-w-0 max-w-(--sz-calc-35) truncate font-mono text-xs text-muted-foreground"
                      title={detail.sourcePath}
                    >
                      {displaySourcePath}
                    </span>
                    <CopyText
                      text={detail.sourcePath}
                      copiedLabel={t("companySkills.copiedPath")}
                      ariaLabel={t("companySkills.copySourcePath")}
                      title={t("companySkills.copySourcePath")}
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
                <span className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("companySkills.pin")}</span>
                <span className="font-mono text-xs">{currentPin ?? t("companySkills.untracked")}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">{t("companySkills.tracking", { ref: updateStatus.trackingRef })}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  {t("companySkills.checkForUpdates")}
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    {t("companySkills.installUpdate")}{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">{t("companySkills.upToDate")}</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("companySkills.key")}</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("companySkills.mode")}</span>
              <span>{detail.editable ? t("companySkills.editable") : t("companySkills.readOnly")}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("companySkills.trustLabel")}</span>
            <TrustChip level={detail.trustLevel} />
            <CompatChip compatibility={detail.compatibility} />
            {readonlyMetadataValue(detail.metadata, "userModifiedAt") ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-(length:--text-micro) text-violet-200">
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    {t("companySkills.locallyModified")}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t("companySkills.locallyModifiedTooltip")}</TooltipContent>
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
              <span className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("companySkills.usedBy")}</span>
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
              <span className="text-muted-foreground">{t("companySkills.noAgentsAttached")}</span>
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
                    {t("companySkills.view")}
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    {t("companySkills.code")}
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  {t("companySkills.cancel")}
                </Button>
                <Button size="sm" onClick={onSave} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? t("companySkills.saving") : t("companySkills.save")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-(--sz-560px) px-5 py-5">
        {fileLoading ? (
          <PageSkeleton variant="detail" />
        ) : !file ? (
          <div className="text-sm text-muted-foreground">{t("companySkills.selectFileToInspect")}</div>
        ) : editMode && file.editable ? (
          file.markdown ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              bordered={false}
              className="min-h-(--sz-520px)"
            />
          ) : (
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-(--sz-520px) rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
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
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const { t } = useTranslation();
  const adapterCaps = useAdapterCapabilities();
  const policyDenial = useSkillPolicyDenial();
  // Route a failed skill mutation to the persistent policy banner when it is an
  // explicit-policy (State B) or platform-safety (State C) denial; otherwise keep
  // the existing transient error toast. This is the core "actionable denial only
  // for real restrictions" behavior from §9.10 (PAP-13865).
  const reportSkillError = (error: unknown, title: string, fallbackBody: string, actionLabel?: string) => {
    if (policyDenial.capture(error, actionLabel)) return;
    pushToast({
      tone: "error",
      title,
      body: error instanceof Error && error.message ? error.message : fallbackBody,
    });
  };
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
  const [createError, setCreateError] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFromProjectOpen, setImportFromProjectOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogTarget, setFolderDialogTarget] = useState<FolderListItem | null>(null);
  const [folderDialogParentId, setFolderDialogParentId] = useState<string | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderListItem | null>(null);
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  // Rich move-to-folder dialog (tree picker + inline new-folder + path preview).
  const [moveDialog, setMoveDialog] = useState<
    { skillIds: string[]; title: string; subtitle: string | null; currentFolderId: string | null } | null
  >(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [moveAfterCreateSkillIds, setMoveAfterCreateSkillIds] = useState<string[]>([]);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const isStudioNew = routePath === "studio/new";
  const routeSkillToken = isStudioNew ? null : parsedRoute.skillToken;
  const selectedPath = parsedRoute.filePath;
  const viewParam = searchParams.get("view");
  const activeView: "installed" | "catalog" = viewParam === "catalog" ? "catalog" : "installed";
  const sourceFilterParam = searchParams.get("source") ?? "all";
  const sourceFilter: SourceFilter = (["all", "company", "bundled", "optional", "external"] as SourceFilter[]).includes(sourceFilterParam as SourceFilter)
    ? (sourceFilterParam as SourceFilter)
    : "all";
  const selectedCatalogRef = searchParams.get("catalog");
  const tabParam = searchParams.get("tab");
  const discoveryTab = resolveDiscoveryTab(tabParam);
  const detailTab: SkillDetailTab = (["overview", "files", "versions", "agents"] as SkillDetailTab[]).includes(tabParam as SkillDetailTab)
    ? (tabParam as SkillDetailTab)
    : parsedRoute.hasExplicitFilePath || selectedPath !== "SKILL.md"
      ? "files"
      : "overview";
  const discoveryCategory = searchParams.get("category");
  const studioForkFromId = isStudioNew ? searchParams.get("forkFrom")?.trim() || null : null;
  const studioNewFolderId = isStudioNew ? searchParams.get("folderId")?.trim() || null : null;
  // Discovery grid owns `/skills` whenever no specific skill or catalog entry is
  // selected; selecting either drops into the existing master/detail surfaces.
  const isDiscovery = !isStudioNew && !routeSkillToken && !selectedCatalogRef;
  const folderSelection = normalizeFolderSelection(searchParams.get("folder"));

  function setDiscoveryTab(tab: DiscoveryTab) {
    setSearchParams((current) => withDiscoveryTab(current, tab));
  }

  function setFolderSelection(selection: FolderSelection) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("tab", "installed");
      params.delete("category");
      const value = folderSearchValue(selection);
      if (value) params.set("folder", value);
      else params.delete("folder");
      return params;
    });
  }

  function openCreateFolder(moveSkillIds: string[] = [], parentId: string | null = null) {
    setMoveAfterCreateSkillIds(moveSkillIds);
    setFolderDialogTarget(null);
    setFolderDialogParentId(parentId);
    setFolderDialogOpen(true);
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

  useEffect(() => {
    if (!isStudioNew) return;
    setCreateError(null);
  }, [isStudioNew, studioForkFromId]);

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
  const skillFoldersQuery = useQuery({
    queryKey: queryKeys.folders.list(selectedCompanyId ?? "", "skill"),
    queryFn: () => foldersApi.list(selectedCompanyId!, "skill"),
    enabled: Boolean(selectedCompanyId && ((isDiscovery && discoveryTab === "installed") || routeSkillToken)),
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

  const studioForkDetailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(selectedCompanyId ?? "", studioForkFromId ?? ""),
    queryFn: () => companySkillsApi.detail(selectedCompanyId!, studioForkFromId!),
    enabled: Boolean(selectedCompanyId && isStudioNew && studioForkFromId),
  });

  const studioDraft = useMemo(() => {
    if (!isStudioNew) return buildBlankSkillDraft();
    const base = studioForkFromId
      ? (studioForkDetailQuery.data ? buildForkSkillDraft(studioForkDetailQuery.data) : buildBlankSkillDraft())
      : buildBlankSkillDraft();
    // New skills created from a folder context (e.g. My Skills) default their
    // destination folder to that folder (PAP-14038).
    return studioNewFolderId ? { ...base, folderId: studioNewFolderId } : base;
  }, [isStudioNew, studioForkDetailQuery.data, studioForkFromId, studioNewFolderId]);

  // The writable folder to seed a new skill into when creating from the browser.
  const defaultNewSkillFolderId = useMemo(() => {
    if (folderSelection === "all" || folderSelection === "unfiled") return null;
    const model = treeFromResult(skillFoldersQuery.data);
    const folder = model.byId.get(folderSelection);
    if (!folder) return null;
    // Never seed into read-only reserved subtrees (Bundled / Projects).
    if (folder.path === "bundled" || folder.path.startsWith("bundled/")) return null;
    if (folder.path === "projects" || folder.path.startsWith("projects/")) return null;
    return folder.id;
  }, [folderSelection, skillFoldersQuery.data]);

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
  useEffect(() => {
    setBreadcrumbs([
      { label: t("companySkills.skillsBreadcrumb"), href: "/skills" },
      ...(isStudioNew
        ? [{ label: studioForkFromId ? t("companySkills.forkSkill") : t("companySkills.newSkillBreadcrumb") }]
        : activeDetail
          ? skillDetailBreadcrumbs(activeDetail, skillFoldersQuery.data).slice(1)
          : routeSkillToken
            ? [{ label: t("companySkills.detailBreadcrumb") }]
            : []),
    ]);
  }, [activeDetail, isStudioNew, routeSkillToken, setBreadcrumbs, skillFoldersQuery.data, studioForkFromId]);
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
        title: t("companySkills.toast.skillsImported"),
        body: t(result.imported.length === 1 ? "companySkills.toast.skillsAdded.single" : "companySkills.toast.skillsAdded.plural", { count: result.imported.length }),
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: t("companySkills.toast.importWarnings"), body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      reportSkillError(error, t("companySkills.toast.importFailed"), t("companySkills.toast.importFailedBody"), t("companySkills.toast.importingSkills"));
    },
  });

  const scanProjects = useMutation({
    mutationFn: (projectId?: string) => companySkillsApi.scanProjects(
      selectedCompanyId!,
      projectId ? { projectIds: [projectId] } : {},
    ),
    onMutate: (projectId) => {
      setScanStatusMessage(
        projectId ? t("companySkills.toast.refreshingProjectSkills") : t("companySkills.toast.scanningWorkspaces"),
      );
    },
    onSuccess: async (result) => {
      setScanStatusMessage(t("companySkills.toast.refreshingSkillsList"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") }),
      ]);
      const summary = formatProjectScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: t("companySkills.toast.scanComplete"),
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: t("companySkills.toast.conflictsFound"),
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: t("companySkills.toast.scanWarnings"),
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      reportSkillError(error, t("companySkills.toast.scanFailed"), t("companySkills.toast.scanFailedBody"), t("companySkills.toast.scanningProjects"));
    },
  });


  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) => companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      navigate(routeForSkill(skill));
      setCreateError(null);
      pushToast({
        tone: "success",
        title: skill.forkedFromSkillId ? t("companySkills.toast.forkCreated") : t("companySkills.toast.skillCreated"),
        body: t("companySkills.toast.createdEditable", { name: skill.name }),
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("companySkills.toast.createFailedBody");
      setCreateError(message);
      reportSkillError(error, t("companySkills.toast.createFailed"), t("companySkills.toast.createFailedBody"), t("companySkills.toast.creatingSkill"));
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
        title: t("companySkills.toast.skillSaved"),
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.saveFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.saveFailedBody"),
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
        title: t("companySkills.toast.starFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.starFailedBody"),
      });
    },
  });

  const updateSkillSettings = useMutation({
    mutationFn: (payload: { skillId: string; updates: Pick<CompanySkillUpdateRequest, "categories" | "sharingScope"> }) =>
      companySkillsApi.update(selectedCompanyId!, payload.skillId, payload.updates),
    onSuccess: async (skill) => {
      queryClient.setQueryData<CompanySkillDetail | undefined>(
        queryKeys.companySkills.detail(selectedCompanyId!, skill.id),
        (current) => current ? { ...current, ...skill } : current,
      );
      queryClient.setQueryData<CompanySkillListItem[] | undefined>(
        queryKeys.companySkills.list(selectedCompanyId!),
        (current) => current?.map((entry) => entry.id === skill.id ? { ...entry, ...skill } : entry),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, skill.id) }),
      ]);
      pushToast({ tone: "success", title: t("companySkills.toast.settingsUpdated"), body: skillSettingsToastBody(skill) });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.settingsUpdateFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.settingsUpdateFailedBody"),
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
        title: t("companySkills.toast.skillUpdated"),
        body: skill.sourceRef ? t("companySkills.toast.pinnedTo", { ref: shortRef(skill.sourceRef) }) : skill.name,
      });
    },
    onError: (error) => {
      reportSkillError(error, t("companySkills.toast.updateFailed"), t("companySkills.toast.installUpdateFailedBody"), t("companySkills.toast.updatingSkill"));
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
  const discoverySearchActive = discoverySearch.trim().length > 0;
  // Selecting a folder shows its whole subtree (folder + descendants), matching
  // the folder-browser model. `null` means no subtree constraint (All/Unfiled).
  const folderSubtreeIds = useMemo(() => {
    if (folderSelection === "all" || folderSelection === "unfiled") return null;
    const model = treeFromResult(skillFoldersQuery.data);
    if (!model.byId.has(folderSelection)) return null;
    return subtreeFolderIds(model, folderSelection);
  }, [folderSelection, skillFoldersQuery.data]);
  const visibleDiscoveryCards = useMemo(() => {
    const filtered = discoveryTabCards.filter((card) => {
      if (discoveryCategory && !card.categories.includes(discoveryCategory)) return false;
      // Search spans all folders (user story 5): the folder filter only
      // narrows when the user is browsing, never when searching.
      if (discoveryTab === "installed" && !discoverySearchActive) {
        if (folderSelection === "unfiled" && card.folderId) return false;
        if (folderSubtreeIds && (!card.folderId || !folderSubtreeIds.has(card.folderId))) return false;
      }
      return discoveryMatchesSearch(card, discoverySearch.trim());
    });
    return sortDiscoveryCards(filtered, discoverySort, discoveryTab !== "bundled");
  }, [discoveryTabCards, discoveryCategory, discoverySearch, discoverySearchActive, discoverySort, discoveryTab, folderSelection, folderSubtreeIds]);

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
        title: result.action === "created" ? t("companySkills.toast.skillInstalled") : result.action === "updated" ? t("companySkills.toast.skillUpdated") : t("companySkills.toast.skillUpToDate"),
        body: result.skill.name,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: t("companySkills.toast.installWarnings"), body: result.warnings[0] });
      }
      if (result.action === "created") {
        navigate(routeForSkill(result.skill));
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("companySkills.toast.installCatalogFailedBody");
      setInstallDialogState((current) => ({ ...current, error: message }));
      // Also surface explicit-policy / platform denials in the persistent banner
      // so the reason stays visible after the dialog closes.
      policyDenial.capture(error, t("companySkills.toast.installingSkill"));
    },
  });
  const createFolder = useMutation({
    mutationFn: (payload: { name: string; color: string | null }) =>
      foldersApi.create(selectedCompanyId!, { kind: "skill", parentId: folderDialogParentId, ...payload }),
    onSuccess: async (folder) => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      setFolderDialogParentId(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") });
      if (moveAfterCreateSkillIds.length > 0) {
        const ids = moveAfterCreateSkillIds;
        setMoveAfterCreateSkillIds([]);
        try {
          await Promise.all(ids.map((itemId) =>
            foldersApi.moveItem(selectedCompanyId!, { kind: "skill", itemId, folderId: folder.id })
          ));
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") }),
          ]);
        } catch (moveError) {
          pushToast({
            tone: "error",
            title: t("companySkills.toast.folderCreatedMoveFailed"),
            body: moveError instanceof Error ? moveError.message : t("companySkills.toast.moveSelectedFailedBody"),
          });
          return;
        }
      } else {
        setFolderSelection(folder.id);
      }
      pushToast({ tone: "success", title: t("companySkills.toast.folderCreated"), body: folder.name });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.folderSaveFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.folderSaveFailedBody"),
      });
    },
  });
  const updateFolder = useMutation({
    mutationFn: ({ folderId, payload }: { folderId: string; payload: { name?: string; color?: string | null } }) =>
      foldersApi.update(selectedCompanyId!, folderId, payload),
    onSuccess: async () => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.folderSaveFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.folderUpdateFailedBody"),
      });
    },
  });
  const moveFolder = useMutation({
    mutationFn: ({ folderId, parentId }: { folderId: string; parentId: string | null }) =>
      foldersApi.moveFolder(selectedCompanyId!, folderId, { parentId, position: 0 }),
    onSuccess: async (folder) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") });
      setFolderSelection(folder.id);
      pushToast({
        tone: "success",
        title: t("companySkills.toast.folderMoved"),
        body: skillFolderPathDisplayFallback(folder.path) ?? folder.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.folderMoveFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.folderMoveFailedBody"),
      });
    },
  });
  const deleteFolder = useMutation({
    mutationFn: (folderId: string) => foldersApi.delete(selectedCompanyId!, folderId),
    onSuccess: async (_, folderId) => {
      if (folderSelection === folderId) setFolderSelection("all");
      setDeleteFolderTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") }),
      ]);
      pushToast({ tone: "success", title: t("companySkills.toast.folderDeleted"), body: t("companySkills.toast.movedToUnfiled") });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.folderDeleteFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.folderDeleteFailedBody"),
      });
    },
  });
  const moveSkillToFolder = useMutation({
    mutationFn: ({ itemId, folderId }: { itemId: string; folderId: string | null }) =>
      foldersApi.moveItem(selectedCompanyId!, { kind: "skill", itemId, folderId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") }),
      ]);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.moveFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.moveSkillFailedBody"),
      });
    },
  });

  async function moveSelectedSkills(folderId: string | null) {
    const ids = selectedSkillIds;
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((itemId) => foldersApi.moveItem(selectedCompanyId!, { kind: "skill", itemId, folderId })));
      setSelectedSkillIds([]);
      setSelectMode(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") }),
      ]);
      pushToast({ tone: "success", title: t("companySkills.toast.skillsMoved"), body: t(ids.length === 1 ? "companySkills.toast.skillsFiled.single" : "companySkills.toast.skillsFiled.plural", { count: ids.length }) });
    } catch (moveError) {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.moveSkillsFailed"),
        body: moveError instanceof Error ? moveError.message : t("companySkills.toast.moveSelectedFailedBody"),
      });
    }
  }

  // Provision the signed-in user's personal "My Skills" root, then select it.
  const ensureMyFolder = useMutation({
    mutationFn: () => foldersApi.ensureMy(selectedCompanyId!),
    onSuccess: async (folder) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") });
      setFolderSelection(folder.id);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.couldntOpenMySkills"),
        body: error instanceof Error ? error.message : t("companySkills.toast.createPersonalFolderFailed"),
      });
    },
  });

  async function openNewSkill() {
    const model = treeFromResult(skillFoldersQuery.data);
    const selectedFolder = folderSelection === "all" || folderSelection === "unfiled"
      ? null
      : model.byId.get(folderSelection) ?? null;
    if (selectedFolder?.systemKey === "my") {
      try {
        const personalFolder = await ensureMyFolder.mutateAsync();
        navigate(skillStudioNewRoute(null, personalFolder.id));
      } catch {
        return;
      }
      return;
    }
    navigate(skillStudioNewRoute(null, defaultNewSkillFolderId));
  }

  async function openCreateFolderIn(parentId: string | null) {
    const parent = parentId ? treeFromResult(skillFoldersQuery.data).byId.get(parentId) : null;
    if (parent?.systemKey === "my") {
      try {
        const personalFolder = await ensureMyFolder.mutateAsync();
        openCreateFolder([], personalFolder.id);
      } catch {
        return;
      }
      return;
    }
    openCreateFolder([], parentId);
  }

  async function moveFolderBetweenScopes(folder: FolderListItem, destination: "my" | "company") {
    if (destination === "company") {
      moveFolder.mutate({ folderId: folder.id, parentId: null });
      return;
    }
    try {
      const personalFolder = await ensureMyFolder.mutateAsync();
      moveFolder.mutate({ folderId: folder.id, parentId: personalFolder.id });
    } catch {
      return;
    }
  }

  // Inline folder creation used by the move dialog's "New folder inside…" affordance.
  async function createFolderInline(parentId: string | null, name: string): Promise<string | null> {
    try {
      const folder = await foldersApi.create(selectedCompanyId!, { kind: "skill", parentId, name, color: null });
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") });
      return folder.id;
    } catch (error) {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.folderCreateFailed"),
        body: error instanceof Error ? error.message : t("companySkills.toast.folderCreateFailedBody"),
      });
      return null;
    }
  }

  // Commit a move initiated from the rich move-to-folder dialog.
  async function performDialogMove(folderId: string | null) {
    if (!moveDialog) return;
    const ids = moveDialog.skillIds;
    try {
      await Promise.all(ids.map((itemId) => foldersApi.moveItem(selectedCompanyId!, { kind: "skill", itemId, folderId })));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "skill") }),
        ...ids.map((itemId) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, itemId) }),
        ),
      ]);
      setMoveDialog(null);
      setSelectedSkillIds([]);
      setSelectMode(false);
      pushToast({
        tone: "success",
        title: ids.length === 1 ? t("companySkills.toast.skillMoved") : t("companySkills.toast.skillsMoved"),
        body: folderId
          ? t("companySkills.toast.filedUnder", { name: skillFolderResult?.folders.find((folder) => folder.id === folderId)?.name ?? t("companySkills.toast.folderFallback") })
          : t("companySkills.toast.movedToUnfiled"),
      });
    } catch (moveError) {
      pushToast({
        tone: "error",
        title: t("companySkills.toast.moveFailed"),
        body: moveError instanceof Error ? moveError.message : t("companySkills.toast.moveFailedBody"),
      });
    }
  }

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
      return agentsApi.syncSkills(input.agentId, input.desiredSkills, "replace", selectedCompanyId ?? undefined);
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
      pushToast({ tone: "success", title: t("companySkills.toast.agentsUpdated"), body: t("companySkills.toast.agentsAttached", { count: nextAgentIds.length }) });
    } catch (error) {
      pushToast({ tone: "error", title: t("companySkills.toast.updateFailed"), body: error instanceof Error ? error.message : t("companySkills.toast.updateAgentSkillsFailed") });
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
        title: t("companySkills.toast.skillRemoved"),
        body: t("companySkills.toast.skillRemovedBody", { name: skill.name }),
      });
    },
    onError: (error) => {
      reportSkillError(error, t("companySkills.toast.removeFailed"), t("companySkills.toast.removeFailedBody"), t("companySkills.toast.removingSkill"));
    },
  });

  const skillFolderResult = skillFoldersQuery.data ?? null;
  const showInstalledFolders = isDiscovery && discoveryTab === "installed";
  // Rail counts reflect the current category/search scope, never the folder
  // filter itself (ux-spec §5.3).
  const railSkillFolderResult = useMemo(() => {
    if (!skillFolderResult || discoveryTab !== "installed") return skillFolderResult;
    const scoped = discoveryTabCards.filter((card) => {
      if (discoveryCategory && !card.categories.includes(discoveryCategory)) return false;
      return discoveryMatchesSearch(card, discoverySearch.trim());
    });
    const direct = new Map<string, number>();
    let unfiled = 0;
    for (const card of scoped) {
      if (card.folderId) direct.set(card.folderId, (direct.get(card.folderId) ?? 0) + 1);
      else unfiled += 1;
    }
    // Roll direct counts up through the tree so a collapsed parent reflects the
    // number of skills anywhere in its subtree, not just its own level.
    const model = treeFromResult(skillFolderResult);
    return {
      ...skillFolderResult,
      allCount: scoped.length,
      unfiledCount: unfiled,
      folders: skillFolderResult.folders.map((folder) => {
        let itemCount = 0;
        for (const id of subtreeFolderIds(model, folder.id)) itemCount += direct.get(id) ?? 0;
        return { ...folder, itemCount };
      }),
    };
  }, [skillFolderResult, discoveryTab, discoveryTabCards, discoveryCategory, discoverySearch]);
  const activeSkillFolderDisplayPath = useMemo(
    () => skillFolderDisplayPath(treeFromResult(skillFolderResult), activeDetail?.folderId),
    [skillFolderResult, activeDetail?.folderId],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message={t("companySkills.selectCompany")} />;
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
  const studioBackHref = studioForkDetailQuery.data ? routeForSkill(studioForkDetailQuery.data) : "/skills";
  const studioTitle = studioForkFromId ? t("companySkills.forkSkill") : t("companySkills.createNewSkillTitle");
  const studioDescription = studioForkFromId
    ? t("companySkills.studioForkDescription")
    : t("companySkills.studioCreateDescription");
  return (
    <>
      {policyDenial.denial ? (
        <div className="px-4 pt-4">
          <SkillPolicyDenialNotice denial={policyDenial.denial} onDismiss={policyDenial.reset} />
        </div>
      ) : null}
      <Dialog open={deleteOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companySkills.removeSkillDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("companySkills.removeSkillDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {deleteTargetDetail
                ? t("companySkills.removeSkillDialog.aboutToRemove", { name: deleteTargetDetail.name })
                : t("companySkills.removeSkillDialog.aboutToRemoveGeneric")}
            </p>
            {deleteTargetDetail?.usedByAgents?.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                {t("companySkills.removeSkillDialog.usedBy", { agents: deleteTargetDetail.usedByAgents.map((agent) => agent.name).join(", ") })}
              </div>
            ) : null}
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                {t("companySkills.removeSkillDialog.detachHint")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <Button variant="ghost" onClick={() => closeDeleteDialog(false)}>
                {t("companySkills.close")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => closeDeleteDialog(false)} disabled={deleteSkill.isPending}>
                  {t("companySkills.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteSkill.mutate()}
                  disabled={deleteSkill.isPending || !deleteTargetSkillId}
                >
                  {deleteSkill.isPending ? t("companySkills.removing") : t("companySkills.removeSkillDialog.confirm")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companySkills.addSourceDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("companySkills.addSourceDialog.description")}
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
                <span className="block font-medium">{t("companySkills.addSourceDialog.browseSkillsSh")}</span>
                <span className="mt-1 block text-muted-foreground">
                  {t("companySkills.addSourceDialog.findCommands")}
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
                <span className="block font-medium">{t("companySkills.addSourceDialog.searchGithub")}</span>
                <span className="mt-1 block text-muted-foreground">
                  {t("companySkills.addSourceDialog.githubHint")}
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

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companySkills.importDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("companySkills.importDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-border pb-2">
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={t("companySkills.importDialog.placeholder")}
                className="h-9 rounded-none border-0 px-0 shadow-none focus-visible:ring-0"
              />
              <Button size="sm" onClick={handleAddSkillSource} disabled={importSkill.isPending}>
                {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : t("companySkills.importDialog.import")}
              </Button>
            </div>
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-sm text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("companySkills.addSourceDialog.browseSkillsSh")}</span>
                <span className="mt-1 block text-muted-foreground">{t("companySkills.addSourceDialog.findCommands")}</span>
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
                <span className="block font-medium">{t("companySkills.addSourceDialog.searchGithub")}</span>
                <span className="mt-1 block text-muted-foreground">{t("companySkills.importDialog.githubHint")}</span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
        </DialogContent>
      </Dialog>

      {selectedCompanyId ? (
        <ImportSkillsFromProjectDialog
          open={importFromProjectOpen}
          onOpenChange={setImportFromProjectOpen}
          companyId={selectedCompanyId}
          onImportFromPath={() => {
            setImportFromProjectOpen(false);
            setImportDialogOpen(true);
          }}
        />
      ) : null}
      <FolderFormDialog
        open={folderDialogOpen}
        kind="skill"
        folder={folderDialogTarget}
        pending={createFolder.isPending || updateFolder.isPending}
        onOpenChange={(open) => {
          setFolderDialogOpen(open);
          if (!open) setFolderDialogParentId(null);
        }}
        onSubmit={(payload) => {
          if (folderDialogTarget) updateFolder.mutate({ folderId: folderDialogTarget.id, payload });
          else createFolder.mutate(payload);
        }}
      />
      <DeleteFolderDialog
        open={deleteFolderTarget !== null}
        folder={deleteFolderTarget}
        itemLabelPlural={t("companySkills.itemLabelPlural")}
        pending={deleteFolder.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderTarget(null);
        }}
        onConfirm={() => {
          if (deleteFolderTarget) deleteFolder.mutate(deleteFolderTarget.id);
        }}
      />
      <MobileFolderSheet
        open={mobileFoldersOpen}
        onOpenChange={setMobileFoldersOpen}
        result={railSkillFolderResult}
        selection={folderSelection}
        allLabel={t("companySkills.allSkills")}
        itemLabelPlural={t("companySkills.itemLabelPluralTitle")}
        onSelect={setFolderSelection}
        onCreate={() => openCreateFolder()}
      />
      <MoveToFolderDialog
        open={moveDialog !== null}
        onOpenChange={(open) => {
          if (!open) setMoveDialog(null);
        }}
        result={railSkillFolderResult}
        title={moveDialog?.title ?? t("companySkills.moveToFolder")}
        subtitle={moveDialog?.subtitle ?? null}
        currentFolderId={moveDialog?.currentFolderId ?? null}
        onMove={(folderId) => void performDialogMove(folderId)}
        onCreateFolder={createFolderInline}
      />

      {isStudioNew ? (
        <div className="min-h-(--sz-calc-30)">
          <div className="border-b border-border px-4 py-5">
            <Link
              to={studioBackHref}
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              {t("companySkills.back")}
            </Link>
            <h1 className="text-2xl font-semibold">{studioTitle}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{studioDescription}</p>
          </div>
          <div className="px-4 py-4">
            <div className="max-w-3xl">
              {studioForkFromId && studioForkDetailQuery.isLoading ? (
                <PageSkeleton variant="detail" />
              ) : studioForkFromId && !studioForkDetailQuery.data ? (
                <EmptyState icon={Boxes} message={t("companySkills.forkSourceNotFound")} />
              ) : (
                <NewSkillWizard
                  initialDraft={studioDraft}
                  onCreate={(payload) => createSkill.mutate(payload)}
                  isPending={createSkill.isPending}
                  error={createError}
                  onCancel={() => navigate(studioBackHref)}
                />
              )}
            </div>
          </div>
        </div>
      ) : isDiscovery ? (
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
          onCreate={() => void openNewSkill()}
          onImport={() => setImportDialogOpen(true)}
          onImportFromProject={() => setImportFromProjectOpen(true)}
          onBrowseCatalog={() => setDiscoveryTab("catalog")}
          onScan={(projectId) => scanProjects.mutate(projectId)}
          scanPending={scanProjects.isPending}
          scanStatus={scanStatusMessage}
          folderResult={showInstalledFolders ? railSkillFolderResult : null}
          folderSelection={folderSelection}
          foldersLoading={skillFoldersQuery.isLoading}
          selectMode={showInstalledFolders && selectMode}
          selectedSkillIds={selectedSkillIds}
          onFolderSelect={showInstalledFolders ? setFolderSelection : undefined}
          onOpenMobileFolders={showInstalledFolders ? () => setMobileFoldersOpen(true) : undefined}
          onCreateFolder={showInstalledFolders ? () => openCreateFolder() : undefined}
          onCreateFolderIn={showInstalledFolders ? (parentId) => void openCreateFolderIn(parentId) : undefined}
          onEnsureMyFolder={showInstalledFolders ? () => ensureMyFolder.mutate() : undefined}
          onOpenMoveCard={showInstalledFolders ? (card) => {
            if (!card.skillId) return;
            setMoveDialog({
              skillIds: [card.skillId],
              title: t("companySkills.moveNamed", { name: card.name }),
              subtitle: t("companySkills.chooseDestination"),
              currentFolderId: card.folderId ?? null,
            });
          } : undefined}
          onRenameFolder={showInstalledFolders ? (folder, name) => updateFolder.mutate({ folderId: folder.id, payload: { name } }) : undefined}
          onEditFolder={showInstalledFolders ? (folder) => {
            setFolderDialogTarget(folder);
            setFolderDialogOpen(true);
          } : undefined}
          onMoveFolder={showInstalledFolders ? (folder, destination) => void moveFolderBetweenScopes(folder, destination) : undefined}
          onDeleteFolder={showInstalledFolders ? setDeleteFolderTarget : undefined}
          onToggleSelectMode={showInstalledFolders ? () => {
            setSelectMode((current) => !current);
            if (selectMode) setSelectedSkillIds([]);
          } : undefined}
          onSelectCard={showInstalledFolders ? (card, selected) => {
            if (!card.skillId) return;
            setSelectedSkillIds((current) =>
              selected
                ? Array.from(new Set([...current, card.skillId!]))
                : current.filter((id) => id !== card.skillId)
            );
          } : undefined}
          onMoveCard={showInstalledFolders ? (card, folderId) => {
            if (!card.skillId) return;
            const skillId = card.skillId;
            const previousFolderId = card.folderId ?? null;
            moveSkillToFolder.mutate({ itemId: skillId, folderId });
            pushToast({
              tone: "success",
              title: t("companySkills.toast.skillMoved"),
              body: folderId
                ? t("companySkills.toast.movedToFolder", { name: card.name, folder: skillFolderResult?.folders.find((folder) => folder.id === folderId)?.name ?? t("companySkills.toast.folderFallback") })
                : t("companySkills.toast.movedToUnfiledNamed", { name: card.name }),
              action: {
                label: t("companySkills.undo"),
                onClick: () => moveSkillToFolder.mutate({ itemId: skillId, folderId: previousFolderId }),
              },
            });
          } : undefined}
          onCreateFolderAndMoveCard={showInstalledFolders ? (card) => {
            if (card.skillId) openCreateFolder([card.skillId]);
          } : undefined}
          onMoveSelected={showInstalledFolders ? (folderId) => void moveSelectedSkills(folderId) : undefined}
          onCreateFolderAndMoveSelected={showInstalledFolders ? () => openCreateFolder(selectedSkillIds) : undefined}
          onClearSelected={showInstalledFolders ? () => setSelectedSkillIds([]) : undefined}
          folderNudgeStorageKey={showInstalledFolders ? `paperclip:skills-folder-nudge:${selectedCompanyId ?? "none"}` : undefined}
        />
      ) : activeView === "installed" && selectedSkillId ? (
        <SkillDetailPage
          detail={activeDetail}
          folderDisplayPath={activeSkillFolderDisplayPath}
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
          onFork={() => activeDetail && navigate(skillStudioNewRoute(activeDetail.id))}
          onUpdateSettings={(updates) => activeDetail && updateSkillSettings.mutate({ skillId: activeDetail.id, updates })}
          onMoveToFolder={activeDetail ? () => setMoveDialog({
            skillIds: [activeDetail.id],
            title: t("companySkills.moveNamed", { name: activeDetail.name }),
            subtitle: t("companySkills.chooseDestination"),
            currentFolderId: activeDetail.folderId ?? null,
          }) : undefined}
          updateSettingsPending={updateSkillSettings.isPending}
          onDelete={openDeleteDialog}
          deletePending={deleteSkill.isPending}
          studioHref={skillStudioRoute(selectedSkillId)}
        />
      ) : selectedCatalogRef ? (
        // Catalog / optional / bundled skills open as a regular full page in the
        // new store — no modal, no legacy split view (PAP-10907).
        <div className="min-h-(--sz-calc-30)">
          <div className="border-b border-border px-4 py-3">
            <Link
              to={backToStoreHref}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              {t("companySkills.backToStore")}
            </Link>
          </div>
          {catalogListQuery.isLoading || catalogDetailQuery.isLoading ? (
            <PageSkeleton variant="detail" />
          ) : !selectedCatalogSkill ? (
            <EmptyState icon={Boxes} message={t("companySkills.catalogSkillNotFound")} />
          ) : (
            <div className="grid gap-0 xl:grid-cols-(--gtc-30)">
              <aside className="border-b border-border px-3 py-4 xl:border-b-0 xl:border-r">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("companySkills.files")}</div>
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
        <div className="min-h-(--sz-calc-30)">
          {skillsQuery.isLoading ? (
            <PageSkeleton variant="detail" />
          ) : (
            <EmptyState icon={Boxes} message={t("companySkills.skillNotFound")} />
          )}
        </div>
      )}
    </>
  );
}
