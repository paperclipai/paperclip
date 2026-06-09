import { useEffect, useMemo, useState, type SVGProps } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  CatalogSkill,
  CatalogSkillFileDetail,
  CompanySkillCompatibility,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillSourceBadge,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
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
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  ArrowUpCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  Eye,
  Filter,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Globe,
  HelpCircle,
  Link2,
  ExternalLink,
  Paperclip,
  Pencil,
  Plus,
  Copy,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Users,
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
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: "GitHub managed" };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: "URL managed" };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: "Folder managed" };
    case "paperclip":
      return { icon: Paperclip, label: sourceLabel ?? "Paperclip", managedLabel: "Paperclip managed" };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: "Catalog managed" };
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
    `${result.discovered} found`,
    `${result.imported.length} imported`,
    `${result.updated.length} updated`,
  ];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return `${parts.join(", ")} across ${result.scannedWorkspaces} workspace${result.scannedWorkspaces === 1 ? "" : "s"}.`;
}

function fileIcon(kind: CompanySkillFileInventoryEntry["kind"]) {
  if (kind === "script" || kind === "reference") return FileCode2;
  return FileText;
}

function encodeSkillFilePath(filePath: string) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeSkillFilePath(filePath: string | undefined) {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function parseSkillRoute(routePath: string | undefined) {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  const [rawSkillId, rawMode, ...rest] = segments;
  const skillId = rawSkillId ? decodeURIComponent(rawSkillId) : null;
  if (!skillId) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  if (rawMode === "files") {
    return {
      skillId,
      filePath: decodeSkillFilePath(rest.join("/")),
    };
  }

  return { skillId, filePath: "SKILL.md" };
}

function skillRoute(skillId: string, filePath?: string | null) {
  return filePath ? `/skills/${skillId}/files/${encodeSkillFilePath(filePath)}` : `/skills/${skillId}`;
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
  all: "All",
  company: "Company",
  bundled: "Bundled",
  optional: "Optional",
  external: "External",
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("relative shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
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
        <DropdownMenuLabel>Source</DropdownMenuLabel>
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("relative shrink-0", activeFilterCount > 0 && "text-blue-600 dark:text-blue-400")}
          title={activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
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
        <DropdownMenuLabel>Type</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={kindFilter} onValueChange={(next) => onKindChange(next as "all" | "bundled" | "optional")}>
          <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bundled">Bundled</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="optional">Optional</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Category</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={categoryFilter || "__all__"} onValueChange={(next) => onCategoryChange(next === "__all__" ? "" : next)}>
          <DropdownMenuRadioItem value="__all__">All categories</DropdownMenuRadioItem>
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
  const map = {
    markdown_only: {
      icon: ShieldCheck,
      label: "Markdown only",
      tooltip: "Text only — no scripts, no binaries, no assets.",
      className: "border-border bg-muted/40 text-muted-foreground",
    },
    assets: {
      icon: Folder,
      label: "Includes assets",
      tooltip: "Ships images, fonts, or other non-script files.",
      className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-200",
    },
    scripts_executables: {
      icon: AlertTriangle,
      label: "Includes scripts",
      tooltip: "Ships executable scripts. Review before installing.",
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
  if (compatibility === "compatible") return null;
  const map = {
    unknown: {
      icon: HelpCircle,
      label: "Unknown format",
      tooltip: "Paperclip could not validate this skill as Agent Skills markdown. Install at your own risk.",
      className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-200",
    },
    invalid: {
      icon: XOctagon,
      label: "Invalid",
      tooltip: "This skill cannot be installed — content is not valid Agent Skills markdown.",
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
  if (!packageName) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          <Boxes className="h-3 w-3" aria-hidden="true" />
          <span>{packageName}{packageVersion ? ` v${packageVersion}` : ""}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Installed from the app-shipped skills catalog. Provenance is signed by package version and content hash.</TooltipContent>
    </Tooltip>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NewSkillForm({
  onCreate,
  isPending,
  onCancel,
}: {
  onCreate: (payload: CompanySkillCreateRequest) => void;
  isPending: boolean;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="border-b border-border px-4 py-4">
      <div className="space-y-3">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Skill name"
          className="h-9 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <Input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="optional-shortname"
          className="h-9 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Short description"
          className="min-h-20 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onCreate({ name, slug: slug || null, description: description || null })}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending ? "Creating..." : "Create skill"}
          </Button>
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
        No catalog skills match this filter.
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
            aria-label={expanded ? `Collapse ${skill.name}` : `Expand ${skill.name}`}
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
            Bundled · {bundled.length}
          </div>
          {bundled.map(renderRow)}
        </div>
      ) : null}
      {optional.length > 0 && kindFilter !== "bundled" ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Optional · {optional.length}
          </div>
          {optional.map(renderRow)}
        </div>
      ) : null}
      {installed.length > 0 ? (
        <div>
          <div className="border-b border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Installed · {installed.length}
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
  if (!skill) {
    return <EmptyState icon={Boxes} message="Select a catalog skill to inspect." />;
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
              Install skill
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>This skill cannot be installed — its content is not valid Agent Skills markdown.</TooltipContent>
      </Tooltip>
    );
  } else if (!isInstalled) {
    cta = (
      <Button onClick={onInstall} disabled={loadingPrimaryAction}>
        {skill.trustLevel === "scripts_executables" ? <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
        {loadingPrimaryAction ? "Preparing..." : (skill.kind === "bundled" ? "Install bundled skill" : "Install optional skill")}
      </Button>
    );
  } else if (hashOutOfSync) {
    cta = (
      <Button onClick={onUpdate} disabled={loadingPrimaryAction} className="border-amber-500/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30">
        <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
        Update from catalog
      </Button>
    );
  } else {
    cta = (
      <Button variant="ghost" onClick={() => installedSkillId && onOpenInstalled(installedSkillId)}>
        <Check className="mr-1.5 h-3.5 w-3.5" />
        Installed · Open in library
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
                  Update available
                </span>
              </TooltipTrigger>
              <TooltipContent>Catalog content hash has changed since this skill was installed.</TooltipContent>
            </Tooltip>
          ) : null}
          {skill.requires.length > 0 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              Requires: {skill.requires.join(", ")}
            </span>
          ) : null}
          {skill.recommendedForRoles.length > 0 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              Roles: {skill.recommendedForRoles.join(" · ")}
            </span>
          ) : null}
          {skill.tags.length > 0 ? (
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              Tags: {skill.tags.join(" · ")}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="uppercase tracking-[0.18em]">Key</span>
          <span className="font-mono">{skill.key}</span>
          <span className="uppercase tracking-[0.18em]">·</span>
          <span className="uppercase tracking-[0.18em]">Hash</span>
          <span className="font-mono">{skill.contentHash.slice(0, 24)}…</span>
          <CopyText
            text={skill.contentHash}
            copiedLabel="Copied hash"
            ariaLabel="Copy content hash"
            title="Copy content hash"
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
          <div className="text-sm text-destructive">{fileQuery.error instanceof Error ? fileQuery.error.message : "Failed to load file"}</div>
        ) : !fileQuery.data ? (
          <div className="text-sm text-muted-foreground">Select a file to inspect.</div>
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

  useEffect(() => {
    if (!open) return;
    setSlug(defaultSlug ?? "");
    setForce(defaultForce);
    setAdvancedOpen(defaultAction === "replace" || defaultForce);
  }, [open, defaultSlug, defaultForce, defaultAction]);

  if (!skill) return null;

  let confirmLabel = "Install skill";
  let confirmVariant: "default" | "destructive" = "default";
  if (defaultAction === "update") {
    confirmLabel = "Install update";
  } else if (defaultAction === "replace") {
    confirmLabel = "Replace existing skill";
    confirmVariant = "destructive";
  }
  if (isPending) confirmLabel = "Installing…";

  return (
    <Dialog open={open} onOpenChange={(value) => (!isPending ? onOpenChange(value) : null)}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>
            {defaultAction === "update" ? "Update" : defaultAction === "replace" ? "Replace" : "Install"} · {skill.name}
          </DialogTitle>
          <DialogDescription>
            <span className="capitalize">{skill.kind}</span> · {skill.category}
            {packageName ? <> · {packageName}{packageVersion ? ` v${packageVersion}` : ""}</> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-border p-3">
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-xs">
              <div className="text-muted-foreground">Trust</div>
              <div className="flex items-center gap-2">
                <TrustChip level={skill.trustLevel} />
                {skill.trustLevel === "markdown_only" ? (
                  <span className="text-muted-foreground">Safe</span>
                ) : skill.trustLevel === "scripts_executables" ? (
                  <span className="text-amber-200">Review required</span>
                ) : (
                  <span className="text-muted-foreground">Non-script assets</span>
                )}
              </div>
              <div className="text-muted-foreground">Compatibility</div>
              <div className="flex items-center gap-2">
                {skill.compatibility === "compatible" ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Compatible
                  </span>
                ) : (
                  <CompatChip compatibility={skill.compatibility} />
                )}
              </div>
              <div className="text-muted-foreground">Requires</div>
              <div className="text-foreground">{skill.requires.length === 0 ? "none" : skill.requires.join(", ")}</div>
              <div className="text-muted-foreground">Roles</div>
              <div className="text-foreground">{skill.recommendedForRoles.length === 0 ? "any" : skill.recommendedForRoles.join(" · ")}</div>
              <div className="text-muted-foreground">Provenance</div>
              <div className="min-w-0">
                <div className="truncate">{packageName ?? "—"}{packageVersion ? ` v${packageVersion}` : ""}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{skill.contentHash}</div>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              Files ({skill.files.length})
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
              An existing skill with key <span className="font-mono">{conflict.key}</span> is installed (
              {conflict.sourceLabel ?? conflict.sourceType}). Installing will {defaultAction === "update" ? "overwrite the catalog content" : "replace the existing skill"}.
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Advanced
          </button>
          {advancedOpen ? (
            <div className="space-y-3 rounded-md border border-border p-3 text-xs">
              <div>
                <label className="mb-1 block uppercase tracking-wide text-muted-foreground">Slug override</label>
                <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={defaultSlug ?? skill.slug} className="h-8" />
              </div>
              <label className="flex items-center gap-2">
                <Checkbox checked={force} onCheckedChange={(value) => setForce(Boolean(value))} />
                <span>Force replace existing same-key skill</span>
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
            Cancel
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

function AttachAgentsPopover({
  open,
  onOpenChange,
  agents,
  attachedAgentIds,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Array<{ id: string; name: string; adapterType: string; supportsSkills: boolean; required: boolean }>;
  attachedAgentIds: string[];
  pending: boolean;
  onSubmit: (nextIds: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set(attachedAgentIds));

  useEffect(() => {
    if (open) {
      setDraft(new Set(attachedAgentIds));
      setFilter("");
    }
  }, [open, attachedAgentIds]);

  const filtered = agents.filter((agent) => agent.name.toLowerCase().includes(filter.toLowerCase()));
  const eligible = agents.filter((agent) => agent.supportsSkills);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Attach to agents"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="border-b border-border px-3 py-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter agents"
            className="h-8"
          />
        </div>
        {eligible.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            No agents in this company support skills yet.
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
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{agent.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {agent.adapterType}
                      {agent.required ? " · required" : ""}
                      {!agent.supportsSkills ? " · skills not supported" : ""}
                    </span>
                  </span>
                </label>
              );
            })}
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">No matches.</div>
            ) : null}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSubmit(Array.from(draft))} disabled={pending}>
            {pending ? "Saving…" : "Save"}
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
  fileHref?: (skillId: string, path: string) => string;
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
            to={node.path ? fileHref(skillId, node.path) : skillRoute(skillId)}
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
          No {SOURCE_FILTER_LABELS[sourceFilter].toLowerCase()} skills installed.{" "}
          <button type="button" className="text-foreground underline" onClick={onClearFilters}>
            Clear filter
          </button>
        </div>
      );
    }
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No skills match this filter.
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
                to={skillRoute(skill.id)}
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
                aria-label={expanded ? `Collapse ${skill.name}` : `Expand ${skill.name}`}
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
  attachPopoverOpen,
  setAttachPopoverOpen,
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
  attachAgents: Array<{ id: string; name: string; adapterType: string; supportsSkills: boolean; required: boolean }>;
  attachPopoverOpen: boolean;
  setAttachPopoverOpen: (open: boolean) => void;
  onSubmitAttach: (ids: string[]) => void;
  attachPending: boolean;
}) {
  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return (
      <EmptyState
        icon={Boxes}
        message="Select a skill to inspect its files."
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
    ? "Detach this skill from all agents before removing it."
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
              {deletePending ? "Removing..." : "Remove"}
            </Button>
            {detail.editable ? (
              <button
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setEditMode(!editMode)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode ? "Stop editing" : "Edit"}
              </button>
            ) : (
              <div className="text-sm text-muted-foreground">{detail.editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Source</span>
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
                      copiedLabel="Copied path"
                      ariaLabel="Copy source path"
                      title="Copy source path"
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
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Pin</span>
                <span className="font-mono text-xs">{currentPin ?? "untracked"}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">tracking {updateStatus.trackingRef}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  Check for updates
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    Install update{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">Up to date</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Key</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Mode</span>
              <span>{detail.editable ? "Editable" : "Read only"}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Trust</span>
            <TrustChip level={detail.trustLevel} />
            <CompatChip compatibility={detail.compatibility} />
            {readonlyMetadataValue(detail.metadata, "userModifiedAt") ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-200">
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    Locally modified
                  </span>
                </TooltipTrigger>
                <TooltipContent>You have edited this skill after installing. Updates from the catalog will overwrite your changes.</TooltipContent>
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
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Used by</span>
              <AttachAgentsPopover
                open={attachPopoverOpen}
                onOpenChange={setAttachPopoverOpen}
                agents={attachAgents}
                attachedAgentIds={usedBy.map((agent) => agent.id)}
                pending={attachPending}
                onSubmit={onSubmitAttach}
              />
            </div>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">No agents attached</span>
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
                    View
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    Code
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={onSave} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? "Saving..." : "Save"}
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
          <div className="text-sm text-muted-foreground">Select a file to inspect.</div>
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
  const [createOpen, setCreateOpen] = useState(false);
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
  const [attachPopoverOpen, setAttachPopoverOpen] = useState(false);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillId = parsedRoute.skillId;
  const selectedPath = parsedRoute.filePath;
  const viewParam = searchParams.get("view");
  const activeView: "installed" | "catalog" = viewParam === "catalog" ? "catalog" : "installed";
  const sourceFilterParam = searchParams.get("source") ?? "all";
  const sourceFilter: SourceFilter = (["all", "company", "bundled", "optional", "external"] as SourceFilter[]).includes(sourceFilterParam as SourceFilter)
    ? (sourceFilterParam as SourceFilter)
    : "all";
  const selectedCatalogRef = searchParams.get("catalog");

  function setViewParam(view: "installed" | "catalog") {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (view === "installed") next.delete("view");
      else next.set("view", "catalog");
      return next;
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
    setBreadcrumbs([
      { label: "Skills", href: "/skills" },
      ...(routeSkillId ? [{ label: "Detail" }] : []),
    ]);
  }, [routeSkillId, setBreadcrumbs]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const selectedSkillId = useMemo(() => {
    if (!routeSkillId) return skillsQuery.data?.[0]?.id ?? null;
    return routeSkillId;
  }, [routeSkillId, skillsQuery.data]);

  useEffect(() => {
    if (activeView !== "installed" || routeSkillId || !selectedSkillId) return;
    navigate(skillRoute(selectedSkillId), { replace: true });
  }, [activeView, navigate, routeSkillId, selectedSkillId]);

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
      if (result.imported[0]) navigate(skillRoute(result.imported[0].id));
      pushToast({
        tone: "success",
        title: "Skills imported",
        body: `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added.`,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: "Import warnings", body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill import failed",
        body: error instanceof Error ? error.message : "Failed to import skill source.",
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) => companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      navigate(skillRoute(skill.id));
      setCreateOpen(false);
      pushToast({
        tone: "success",
        title: "Skill created",
        body: `${skill.name} is now editable in the Paperclip workspace.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill creation failed",
        body: error instanceof Error ? error.message : "Failed to create skill.",
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onMutate: () => {
      setScanStatusMessage("Scanning project workspaces for skills...");
    },
    onSuccess: async (result) => {
      setScanStatusMessage("Refreshing skills list...");
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      const summary = formatProjectScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: "Project skill scan complete",
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: "Skill conflicts found",
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: "Scan warnings",
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: "Project skill scan failed",
        body: error instanceof Error ? error.message : "Failed to scan project workspaces.",
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
        title: "Skill saved",
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Failed to save skill file.",
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
      navigate(skillRoute(skill.id, selectedPath));
      pushToast({
        tone: "success",
        title: "Skill updated",
        body: skill.sourceRef ? `Pinned to ${shortRef(skill.sourceRef)}` : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : "Failed to install skill update.",
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
    enabled: Boolean(selectedCompanyId && selectedCatalogRef && activeView === "catalog"),
    staleTime: 60_000,
  });

  const catalogFileQuery = useQuery({
    queryKey: queryKeys.companySkills.catalogFile(selectedCatalogRef ?? "", catalogSelectedPath),
    queryFn: () => companySkillsApi.catalogFile(selectedCatalogRef!, catalogSelectedPath),
    enabled: Boolean(selectedCompanyId && selectedCatalogRef && activeView === "catalog" && catalogSelectedPath),
    staleTime: 60_000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const installedSkills = skillsQuery.data ?? [];
  const installedByKey = useMemo(
    () => new Map(installedSkills.map((skill) => [skill.key, skill])),
    [installedSkills],
  );
  const catalogCategories = useMemo(() => {
    const set = new Set<string>();
    for (const skill of catalogListQuery.data ?? []) set.add(skill.category);
    return Array.from(set).sort();
  }, [catalogListQuery.data]);

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
        title: result.action === "created" ? "Skill installed" : result.action === "updated" ? "Skill updated" : "Skill is up to date",
        body: result.skill.name,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: "Install warnings", body: result.warnings[0] });
      }
      if (result.action === "created") {
        setViewParam("installed");
        navigate(skillRoute(result.skill.id));
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to install catalog skill.";
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
        attached: usedSet.has(agent.id),
        requiredKeys,
      };
    });
  }, [agentsQuery.data, adapterCaps, activeDetail]);

  const attachAgentsMutation = useMutation({
    mutationFn: async (input: { agentId: string; desiredSkills: string[] }) => {
      return agentsApi.syncSkills(input.agentId, input.desiredSkills, selectedCompanyId ?? undefined);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId ?? "") }),
      ]);
    },
  });

  async function handleAttachSubmit(nextAgentIds: string[]) {
    if (!activeDetail) return;
    const skillKey = activeDetail.key;
    const targetSet = new Set(nextAgentIds);
    const current = (activeDetail.usedByAgents ?? []).map((entry) => entry.id);
    const currentSet = new Set(current);
    const toAdd = nextAgentIds.filter((id) => !currentSet.has(id));
    const toRemove = current.filter((id) => !targetSet.has(id));
    const affected = new Set<string>([...toAdd, ...toRemove]);
    if (affected.size === 0) {
      setAttachPopoverOpen(false);
      return;
    }
    try {
      for (const agentId of affected) {
        const snapshot = await agentsApi.skills(agentId, selectedCompanyId ?? undefined);
        const current = new Set(snapshot.desiredSkills ?? []);
        if (targetSet.has(agentId)) current.add(skillKey);
        else current.delete(skillKey);
        await attachAgentsMutation.mutateAsync({ agentId, desiredSkills: Array.from(current) });
      }
      pushToast({ tone: "success", title: "Agents updated", body: `${nextAgentIds.length} agent(s) attached.` });
      setAttachPopoverOpen(false);
    } catch (error) {
      pushToast({ tone: "error", title: "Update failed", body: error instanceof Error ? error.message : "Failed to update agent skills." });
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
        title: "Skill removed",
        body: `${skill.name} was removed from the company skill library.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Remove failed",
        body: error instanceof Error ? error.message : "Failed to remove skill.",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message="Select a company to manage skills." />;
  }

  function handleAddSkillSource() {
    const trimmedSource = source.trim();
    if (trimmedSource.length === 0) {
      setEmptySourceHelpOpen(true);
      return;
    }
    importSkill.mutate(trimmedSource);
  }

  return (
    <>
      <Dialog open={deleteOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove skill</DialogTitle>
            <DialogDescription>
              Remove this skill from the company library. If any agents still use it, removal will be blocked until it is detached.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {deleteTargetDetail
                ? `You are about to remove ${deleteTargetDetail.name}.`
                : "You are about to remove this skill."}
            </p>
            {deleteTargetDetail?.usedByAgents?.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                Currently used by {deleteTargetDetail.usedByAgents.map((agent) => agent.name).join(", ")}.
              </div>
            ) : null}
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                Detach this skill from all agents to enable removal.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <Button variant="ghost" onClick={() => closeDeleteDialog(false)}>
                Close
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => closeDeleteDialog(false)} disabled={deleteSkill.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteSkill.mutate()}
                  disabled={deleteSkill.isPending || !deleteTargetSkillId}
                >
                  {deleteSkill.isPending ? "Removing..." : "Remove skill"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a skill source</DialogTitle>
            <DialogDescription>
              Paste a local path, GitHub URL, or `skills.sh` command into the field first.
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
                <span className="block font-medium">Browse skills.sh</span>
                <span className="mt-1 block text-muted-foreground">
                  Find install commands and paste one here.
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
                <span className="block font-medium">Search GitHub</span>
                <span className="mt-1 block text-muted-foreground">
                  Look for repositories with `SKILL.md`, then paste the repo URL here.
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

      <div className="flex min-h-[calc(100vh-12rem)] flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 pt-3 pb-[5px]">
          <Tabs value={activeView} onValueChange={(value) => setViewParam(value === "catalog" ? "catalog" : "installed")}>
            <TabsList variant="line" className="p-0">
              <TabsTrigger value="installed" className="px-3">
                <span>Installed</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{installedSkills.length}</span>
              </TabsTrigger>
              <TabsTrigger value="catalog" className="px-3">
                <span>Catalog</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">{catalogListQuery.data?.length ?? 0}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            {activeView === "installed" ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => scanProjects.mutate()}
                disabled={scanProjects.isPending}
                title="Scan project workspaces for skills"
              >
                <RefreshCw className={cn("h-4 w-4", scanProjects.isPending && "animate-spin")} />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="default">
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add skill
                  <ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setViewParam("catalog")}>
                  <Boxes className="mr-2 h-4 w-4" />
                  Browse catalog
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setViewParam("installed");
                    setEmptySourceHelpOpen(true);
                  }}
                >
                  <Globe className="mr-2 h-4 w-4" />
                  Import from URL or path
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setViewParam("installed");
                    setCreateOpen(true);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Create blank skill
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {activeView === "installed" ? (
          <div className="grid flex-1 gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
            <aside className="border-r border-border">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center gap-2 border-b border-border pb-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    value={skillFilter}
                    onChange={(event) => setSkillFilter(event.target.value)}
                    placeholder="Filter skills"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <SourceFilterMenu counts={sourceCounts} value={sourceFilter} onChange={setSourceFilter} />
                </div>

                <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
                  <input
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                    placeholder="Paste path, GitHub URL, or skills.sh command"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleAddSkillSource}
                    disabled={importSkill.isPending}
                  >
                    {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Add"}
                  </Button>
                </div>
                {scanStatusMessage && (
                  <p className="mt-3 text-xs text-muted-foreground">{scanStatusMessage}</p>
                )}
              </div>

              {createOpen && (
                <NewSkillForm
                  onCreate={(payload) => createSkill.mutate(payload)}
                  isPending={createSkill.isPending}
                  onCancel={() => setCreateOpen(false)}
                />
              )}

              {skillsQuery.isLoading ? (
                <PageSkeleton variant="list" />
              ) : skillsQuery.error ? (
                <div className="px-4 py-6 text-sm text-destructive">{skillsQuery.error.message}</div>
              ) : installedSkills.length === 0 ? (
                <div className="px-4 py-8">
                  <EmptyState
                    icon={Boxes}
                    message="No skills installed yet."
                  />
                  <div className="mt-3 flex flex-col items-center gap-2">
                    <Button size="sm" onClick={() => setViewParam("catalog")}>
                      <Boxes className="mr-1.5 h-3.5 w-3.5" /> Browse catalog
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEmptySourceHelpOpen(true)}>
                      Import from URL
                    </Button>
                  </div>
                </div>
              ) : (
                <SkillList
                  skills={installedSkills}
                  selectedSkillId={selectedSkillId}
                  skillFilter={skillFilter}
                  sourceFilter={sourceFilter}
                  expandedSkillId={expandedSkillId}
                  expandedDirs={expandedDirs}
                  selectedPaths={selectedSkillId ? { [selectedSkillId]: selectedPath } : {}}
                  onToggleSkill={(currentSkillId) =>
                    setExpandedSkillId((current) => current === currentSkillId ? null : currentSkillId)
                  }
                  onToggleDir={(currentSkillId, path) => {
                    setExpandedDirs((current) => {
                      const next = new Set(current[currentSkillId] ?? []);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return { ...current, [currentSkillId]: next };
                    });
                  }}
                  onSelectSkill={(currentSkillId) => setExpandedSkillId(currentSkillId)}
                  onSelectPath={() => {}}
                  onClearFilters={() => setSourceFilter("all")}
                />
              )}
            </aside>

            <div className="min-w-0 pl-6">
              <SkillPane
                loading={skillsQuery.isLoading || detailQuery.isLoading}
                detail={activeDetail}
                file={activeFile}
                fileLoading={fileQuery.isLoading && !activeFile}
                updateStatus={updateStatusQuery.data}
                updateStatusLoading={updateStatusQuery.isLoading}
                viewMode={viewMode}
                editMode={editMode}
                draft={draft}
                setViewMode={setViewMode}
                setEditMode={setEditMode}
                setDraft={setDraft}
                onCheckUpdates={() => {
                  void updateStatusQuery.refetch();
                }}
                checkUpdatesPending={updateStatusQuery.isFetching}
                onInstallUpdate={() => installUpdate.mutate()}
                installUpdatePending={installUpdate.isPending}
                onDelete={openDeleteDialog}
                deletePending={deleteSkill.isPending}
                onSave={() => saveFile.mutate()}
                savePending={saveFile.isPending}
                attachAgents={eligibleAgentsForAttach}
                attachPopoverOpen={attachPopoverOpen}
                setAttachPopoverOpen={setAttachPopoverOpen}
                onSubmitAttach={handleAttachSubmit}
                attachPending={attachAgentsMutation.isPending}
              />
            </div>
          </div>
        ) : (
          <div className="grid flex-1 gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
            <aside className="border-r border-border">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center gap-2 border-b border-border pb-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    value={catalogFilter}
                    onChange={(event) => setCatalogFilter(event.target.value)}
                    placeholder="Search catalog"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <CatalogFilterMenu
                    kindFilter={catalogKindFilter}
                    categoryFilter={catalogCategoryFilter}
                    categories={catalogCategories}
                    onKindChange={setCatalogKindFilter}
                    onCategoryChange={setCatalogCategoryFilter}
                  />
                </div>
              </div>

              {catalogListQuery.isLoading ? (
                <PageSkeleton variant="list" />
              ) : catalogListQuery.error ? (
                <div className="px-4 py-6 text-sm text-destructive">{catalogListQuery.error.message}</div>
              ) : (
                <CatalogList
                  skills={catalogListQuery.data ?? []}
                  kindFilter={catalogKindFilter}
                  categoryFilter={catalogCategoryFilter}
                  catalogFilter={catalogFilter}
                  installedByKey={installedByKey}
                  selectedCatalogRef={selectedCatalogRef}
                  selectedPath={catalogSelectedPath}
                  expandedSkillId={expandedCatalogSkillId}
                  expandedDirs={expandedCatalogDirs}
                  onSelect={selectCatalog}
                  onSelectPath={selectCatalog}
                  onToggleSkill={(catalogRef) =>
                    setExpandedCatalogSkillId((current) => current === catalogRef ? null : catalogRef)
                  }
                  onToggleDir={(catalogRef, path) => {
                    setExpandedCatalogDirs((current) => {
                      const next = new Set(current[catalogRef] ?? []);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return { ...current, [catalogRef]: next };
                    });
                  }}
                />
              )}
            </aside>

            <div className="min-w-0 pl-6">
              <CatalogDetailPane
                skill={selectedCatalogSkill}
                packageName={selectedCatalogSkill?.packageName ?? (selectedCatalogSkill ? installedByKey.get(selectedCatalogSkill.key)?.packageName : null) ?? null}
                packageVersion={selectedCatalogSkill?.packageVersion ?? (selectedCatalogSkill ? installedByKey.get(selectedCatalogSkill.key)?.packageVersion : null) ?? null}
                installedSkill={selectedCatalogSkill ? installedByKey.get(selectedCatalogSkill.key) ?? null : null}
                installedSkillId={(selectedCatalogSkill ? installedByKey.get(selectedCatalogSkill.key)?.id : null) ?? null}
                fileQuery={catalogFileQuery}
                selectedPath={catalogSelectedPath}
                onInstall={() => selectedCatalogSkill && openInstallDialog(selectedCatalogSkill)}
                onUpdate={() => selectedCatalogSkill && openInstallDialog(selectedCatalogSkill)}
                onOpenInstalled={(skillId) => {
                  setViewParam("installed");
                  navigate(skillRoute(skillId));
                }}
                loadingPrimaryAction={installCatalog.isPending}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
