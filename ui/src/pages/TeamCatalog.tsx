import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  CatalogTeam,
  CatalogTeamEnvInputSummary,
  CatalogTeamImportPreviewResult,
  CatalogTeamSkillPreparation,
  CatalogTeamSkillRequirement,
  CatalogTeamSourceRef,
  CatalogTeamTrustLevel,
  CatalogTeamCompatibility,
  CatalogTeamImportOptions,
  CatalogTeamInstallOptions,
  CatalogTeamInstallResult,
  InstalledCatalogTeam,
  CompanyPortabilityAdapterOverride,
  CompanyPortabilityCollisionStrategy,
} from "@paperclipai/shared";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { teamCatalogApi } from "../api/teamCatalog";
import { agentsApi } from "../api/agents";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Crown,
  Download,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Folder,
  FolderKanban,
  FolderOpen,
  Github,
  KeyRound,
  Link2,
  Loader2,
  Package,
  Repeat,
  RotateCcw,
  Search,
  ShieldCheck,
  Users2,
  XCircle,
  XOctagon,
} from "lucide-react";

// Matches design §11 breakpoints. Module-level so stories and the page agree.
const DESKTOP_MIN = 1024;
const MOBILE_MAX = 767;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

// ---------------------------------------------------------------------------
// Risk model — derived client-side from the team's source refs (design §8).
// ---------------------------------------------------------------------------

type TeamRisk = "safe" | "has_warnings" | "blocked";

const UI_UNSUPPORTED_SOURCE_TYPES = new Set<CatalogTeamSourceRef["type"]>([
  "local_path",
  "agent_package",
]);

function sourceWarningCode(
  source: CatalogTeamSourceRef,
): "ok" | "unpinned" | "unsupported_in_ui" {
  if (UI_UNSUPPORTED_SOURCE_TYPES.has(source.type)) return "unsupported_in_ui";
  if (!source.pinned) return "unpinned";
  return "ok";
}

function teamRisk(team: CatalogTeam): TeamRisk {
  let risk: TeamRisk = "safe";
  for (const source of team.sourceRefs) {
    const code = sourceWarningCode(source);
    if (code === "unsupported_in_ui") return "blocked";
    if (code === "unpinned") risk = "has_warnings";
  }
  return risk;
}

function externalSourceCount(team: CatalogTeam): number {
  return team.sourceRefs.filter((s) => s.type !== "include").length;
}

function skillCount(team: CatalogTeam): number {
  return (
    team.counts.localSkills + team.counts.catalogSkills + team.counts.externalSkillSources
  );
}

function titleCase(slug: string): string {
  return slug
    .replace(/[-_/]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function encodeTeamFilePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("%7E");
}

function decodeTeamFilePath(encoded: string | undefined): string | null {
  if (!encoded) return null;
  return encoded.split("%7E").map(decodeURIComponent).join("/");
}

type ParsedRoute = { catalogRef: string | null; filePath: string | null };

const TEAM_CATALOG_ROUTE_ROOT = "/teams-catalog";

export function parseTeamRoute(routePath: string | undefined): ParsedRoute {
  if (!routePath) return { catalogRef: null, filePath: null };
  const segments = routePath.split("/").filter(Boolean);
  if (segments.length === 0) return { catalogRef: null, filePath: null };
  const catalogRef = decodeURIComponent(segments[0]);
  if (segments[1] === "files" && segments[2]) {
    return { catalogRef, filePath: decodeTeamFilePath(segments[2]) };
  }
  return { catalogRef, filePath: null };
}

export function teamRoute(catalogRef: string, filePath?: string | null): string {
  const base = `${TEAM_CATALOG_ROUTE_ROOT}/${encodeURIComponent(catalogRef)}`;
  if (filePath) return `${base}/files/${encodeTeamFilePath(filePath)}`;
  return base;
}

// ---------------------------------------------------------------------------
// Small presentational components (siblings of the Skills catalog chips).
// ---------------------------------------------------------------------------

const TRUST_META: Record<
  CatalogTeamTrustLevel,
  { label: string; tip: string; tone: string; Icon: typeof ShieldCheck }
> = {
  markdown_only: {
    label: "Markdown only",
    tip: "Contains only markdown and references. No executable content.",
    tone: "text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
    Icon: ShieldCheck,
  },
  assets: {
    label: "Assets",
    tip: "Includes static assets (images, fixtures). No executable content.",
    tone: "text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
    Icon: ShieldCheck,
  },
  scripts_executables: {
    label: "Scripts",
    tip: "Includes executable scripts that were security-reviewed before bundling.",
    tone: "text-amber-600 dark:text-amber-300 border-amber-500/30",
    Icon: AlertTriangle,
  },
  external_sources: {
    label: "External sources",
    tip: "References external sources resolved at install time.",
    tone: "text-amber-600 dark:text-amber-300 border-amber-500/30",
    Icon: AlertTriangle,
  },
};

function TrustChip({ level, iconOnly = false }: { level: CatalogTeamTrustLevel; iconOnly?: boolean }) {
  const meta = TRUST_META[level];
  const { Icon } = meta;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline"
          className={cn(
            "px-1.5 text-(length:--text-micro)",
            meta.tone,
          )}
        >
          <Icon className="h-3 w-3" />
          {!iconOnly && meta.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{meta.tip}</TooltipContent>
    </Tooltip>
  );
}

const COMPAT_META: Record<
  CatalogTeamCompatibility,
  { label: string; tone: string }
> = {
  compatible: { label: "Compatible", tone: "text-emerald-600 dark:text-emerald-300 border-emerald-500/30" },
  unknown: { label: "Unknown compat", tone: "text-muted-foreground border-border" },
  invalid: { label: "Invalid", tone: "text-rose-600 dark:text-rose-300 border-rose-500/30" },
};

function CompatChip({ compatibility }: { compatibility: CatalogTeamCompatibility }) {
  const meta = COMPAT_META[compatibility];
  return (
    <Badge variant="outline"
      className={cn(
        "px-1.5 text-(length:--text-micro)",
        meta.tone,
      )}
    >
      {meta.label}
    </Badge>
  );
}

function ProvenanceBadge({ team }: { team: CatalogTeam }) {
  if (!team.packageName) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="border-border px-1.5 text-(length:--text-micro) text-muted-foreground">
          <Package className="h-3 w-3" />
          {team.packageName}
          {team.packageVersion ? `@${team.packageVersion}` : ""}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Catalog package provenance</TooltipContent>
    </Tooltip>
  );
}

function RiskBanner({ team }: { team: CatalogTeam }) {
  const unsafe = team.sourceRefs.filter(
    (s) => sourceWarningCode(s) !== "ok",
  );
  if (unsafe.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-amber-700 dark:text-amber-300"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4" />
        This team references {unsafe.length} external source
        {unsafe.length === 1 ? "" : "s"}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-xs">
        {unsafe.map((s) => (
          <li key={`${s.type}:${s.ref}`} className="font-mono">
            {s.ref}{" "}
            <span className="not-italic font-sans opacity-80">
              ({sourceWarningCode(s) === "unsupported_in_ui" ? "unsupported in browser install" : "unpinned"})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function sourceKindIcon(type: CatalogTeamSourceRef["type"]) {
  switch (type) {
    case "github":
      return Github;
    case "url":
      return Link2;
    case "local_path":
      return Folder;
    case "agent_package":
      return Package;
    case "skills_sh":
      return Boxes;
    default:
      return Link2;
  }
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

type TreeNode = {
  name: string;
  path: string | null;
  kind: "dir" | "file";
  children: TreeNode[];
};

function buildTree(files: CatalogTeam["files"]): TreeNode[] {
  const root: TreeNode = { name: "", path: null, kind: "dir", children: [] };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split("/");
    let cursor = root;
    parts.forEach((part, idx) => {
      const isLeaf = idx === parts.length - 1;
      let child = cursor.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: isLeaf ? file.path : null,
          kind: isLeaf ? "file" : "dir",
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    });
  }
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function TeamFileTree({
  nodes,
  depth = 0,
  selectedPath,
  expanded,
  onToggleDir,
  onSelectFile,
}: {
  nodes: TreeNode[];
  depth?: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggleDir: (name: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ul className="text-xs">
      {nodes.map((node) => {
        const key = node.path ?? `dir:${depth}:${node.name}`;
        if (node.kind === "dir") {
          const open = expanded.has(node.name);
          const DirIcon = open ? FolderOpen : Folder;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onToggleDir(node.name)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent/40"
                style={{ paddingLeft: depth * 14 + 6 }}
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <DirIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{node.name}</span>
              </button>
              {open && (
                <TeamFileTree
                  nodes={node.children}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  expanded={expanded}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                />
              )}
            </li>
          );
        }
        const active = node.path === selectedPath;
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => node.path && onSelectFile(node.path)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent/40",
                active && "bg-accent/50 text-foreground",
              )}
              style={{ paddingLeft: depth * 14 + 22 }}
            >
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{node.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Agent hierarchy preview (manifest exposes agentSlugs + rootAgentSlugs only;
// per-agent reportsTo is not in the list manifest, so we render roots distinctly
// and group the remaining members — graceful degradation per design §7).
// ---------------------------------------------------------------------------

export function TeamHierarchyPreview({ team }: { team: CatalogTeam }) {
  const roots = new Set(team.rootAgentSlugs);
  const members = team.agentSlugs.filter((slug) => !roots.has(slug));
  const requiresManager = team.rootAgentSlugs.length > 0;
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-border">
      <ul className="divide-y divide-border/60">
        {team.rootAgentSlugs.map((slug) => (
          <li
            key={slug}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm",
              requiresManager && "border-l-2 border-amber-500/50",
            )}
          >
            <Crown className="h-3.5 w-3.5 text-amber-500" />
            <span className="font-medium">{titleCase(slug)}</span>
            <span className="text-xs text-muted-foreground">root agent</span>
          </li>
        ))}
        {members.map((slug) => (
          <li key={slug} className="flex items-center gap-2 px-3 py-2 pl-7 text-sm">
            <Users2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{titleCase(slug)}</span>
          </li>
        ))}
        {team.agentSlugs.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted-foreground">No agents in this team.</li>
        )}
      </ul>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

function MetricTile({
  label,
  value,
  Icon,
}: {
  label: string;
  value: number;
  Icon: typeof Users2;
}) {
  return (
    <Card className="block px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xl font-semibold tabular-nums">{value}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Card>
  );
}

export function RequiredSkillsList({ skills }: { skills: CatalogTeamSkillRequirement[] }) {
  if (skills.length === 0) return <p className="text-sm text-muted-foreground">No required skills.</p>;
  return (
    <ul className="space-y-1">
      {skills.map((skill) => (
        <li
          key={`${skill.type}:${skill.ref}`}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
        >
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-xs">{skill.ref}</span>
          <Badge variant="outline" className="ml-auto text-(length:--text-nano)">
            {skill.type}
          </Badge>
          {skill.resolved ? (
            <Badge variant="outline" className="text-(length:--text-nano) text-emerald-600 dark:text-emerald-300 border-emerald-500/30">
              resolved
            </Badge>
          ) : (
            <Badge variant="outline" className="text-(length:--text-nano) text-amber-600 dark:text-amber-300 border-amber-500/30">
              external
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

export function EnvInputsList({ inputs }: { inputs: CatalogTeamEnvInputSummary[] }) {
  if (inputs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <SectionHeader>Secrets & env inputs</SectionHeader>
      <ul className="space-y-1">
        {inputs.map((input) => (
          <li
            key={input.key}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono text-xs uppercase tracking-wide">{input.key}</span>
            <Badge
              variant="outline"
              className={cn(
                "ml-auto text-(length:--text-nano)",
                input.kind === "secret"
                  ? "text-rose-600 dark:text-rose-300 border-rose-500/30"
                  : "text-muted-foreground",
              )}
            >
              {input.kind}
            </Badge>
            {input.requirement === "required" && (
              <Badge variant="outline" className="text-(length:--text-nano)">required</Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function envInputFormKey(input: CatalogTeamEnvInputSummary) {
  if (input.agentSlug) return `agent:${input.agentSlug}:${input.key}`;
  if (input.projectSlug) return `project:${input.projectSlug}:${input.key}`;
  return input.key;
}

export function ExternalSourcesList({ sources }: { sources: CatalogTeamSourceRef[] }) {
  const external = sources.filter((s) => s.type !== "include");
  const [open, setOpen] = useState(false);
  if (external.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        External sources · {external.length}
      </button>
      {open && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {external.map((source) => {
            const Icon = sourceKindIcon(source.type);
            const code = sourceWarningCode(source);
            return (
              <li key={`${source.type}:${source.ref}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono text-xs truncate">{source.ref}</span>
                <span className="ml-auto text-(length:--text-micro)">
                  {code === "ok" && (
                    <span className="text-emerald-600 dark:text-emerald-300">Pinned</span>
                  )}
                  {code === "unpinned" && (
                    <span className="text-amber-600 dark:text-amber-300">Unpinned</span>
                  )}
                  {code === "unsupported_in_ui" && (
                    <span className="text-rose-600 dark:text-rose-300">Unsupported in browser install</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function TeamDetailPane({
  team,
  selectedPath,
  onSelectFile,
  onInstall,
  canInstall,
  fileContent,
  installed,
}: {
  team: CatalogTeam;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  onInstall: () => void;
  canInstall: boolean;
  fileContent: string | null;
  installed?: InstalledCatalogTeam | null;
}) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(team.files), [team.files]);
  const invalid = team.compatibility === "invalid";
  const unsafe = team.trustLevel === "scripts_executables";
  const isInstalled = Boolean(installed);
  const outOfDate = Boolean(installed?.outOfDate);

  const toggleDir = (name: string) =>
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Installed teams default to update/re-install semantics; out-of-date teams
  // get the primary amber affordance (design §5 / PAP-10256).
  const installButton = (
    <Button
      onClick={onInstall}
      disabled={invalid || !canInstall}
      variant={outOfDate ? "default" : isInstalled ? "outline" : "default"}
    >
      {unsafe ? (
        <AlertTriangle className="h-4 w-4" />
      ) : isInstalled ? (
        <RotateCcw className="h-4 w-4" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      {isInstalled ? "Re-install latest" : "Install team"}
    </Button>
  );

  return (
    <div className="flex-1 overflow-auto">
      <div className="space-y-5 p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-base font-semibold">{team.name}</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={team.kind === "bundled" ? "secondary" : "outline"} className="text-(length:--text-nano) capitalize">
                {team.kind}
              </Badge>
              <span className="text-xs text-muted-foreground">{team.category}</span>
              <TrustChip level={team.trustLevel} />
              <CompatChip compatibility={team.compatibility} />
              <ProvenanceBadge team={team} />
              {isInstalled && !outOfDate && (
                <Badge variant="secondary" className="gap-1 text-(length:--text-nano)">
                  <CheckCircle2 className="h-3 w-3" /> Installed
                </Badge>
              )}
              {outOfDate && (
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-500/40 bg-amber-500/10 text-(length:--text-nano) text-amber-600 dark:text-amber-300"
                >
                  <ChevronUp className="h-3 w-3" /> Update available
                </Badge>
              )}
            </div>
          </div>
          {invalid ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>{installButton}</span>
              </TooltipTrigger>
              <TooltipContent>This team cannot be installed — the package manifest is invalid.</TooltipContent>
            </Tooltip>
          ) : !canInstall ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>{installButton}</span>
              </TooltipTrigger>
              <TooltipContent>Requires board operator or agent-create permissions.</TooltipContent>
            </Tooltip>
          ) : (
            installButton
          )}
        </div>

        <RiskBanner team={team} />

        {/* Description */}
        {team.description && (
          <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
            <MarkdownBody>{team.description}</MarkdownBody>
          </div>
        )}

        {/* Summary grid */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <MetricTile label="Agents" value={team.counts.agents} Icon={Users2} />
          <MetricTile label="Projects" value={team.counts.projects} Icon={FolderKanban} />
          <MetricTile label="Routines" value={team.counts.routines} Icon={Repeat} />
          <MetricTile label="Required skills" value={skillCount(team)} Icon={Boxes} />
        </div>

        {/* Agent hierarchy */}
        <div className="space-y-2">
          <SectionHeader>Agent hierarchy</SectionHeader>
          <TeamHierarchyPreview team={team} />
        </div>

        {/* Projects */}
        {team.projectSlugs.length > 0 && (
          <div className="space-y-2">
            <SectionHeader>Projects</SectionHeader>
            <ul className="space-y-1">
              {team.projectSlugs.map((slug) => (
                <li key={slug} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{titleCase(slug)}</span>
                  <span className="ml-auto font-mono text-(length:--text-micro) text-muted-foreground">{slug}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Required skills */}
        <div className="space-y-2">
          <SectionHeader>Required skills</SectionHeader>
          <RequiredSkillsList skills={team.requiredSkills} />
        </div>

        {/* Env inputs */}
        <EnvInputsList inputs={team.envInputs} />

        {/* External sources */}
        <ExternalSourcesList sources={team.sourceRefs} />

        {/* File inventory */}
        <div className="space-y-2">
          <SectionHeader>Files</SectionHeader>
          <div className="rounded-md border border-border p-1.5">
            <TeamFileTree
              nodes={tree}
              selectedPath={selectedPath}
              expanded={expandedDirs}
              onToggleDir={toggleDir}
              onSelectFile={(path) => onSelectFile(path)}
            />
          </div>
          {selectedPath && (
            <div className="rounded-md border border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="font-mono text-xs">{selectedPath}</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onSelectFile(null)}
                >
                  Close
                </button>
              </div>
              <div className="max-h-96 overflow-auto p-3">
                {fileContent === null ? (
                  <Skeleton className="h-32 w-full" />
                ) : selectedPath.endsWith(".md") ? (
                  <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
                    <MarkdownBody>{fileContent}</MarkdownBody>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">{fileContent}</pre>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Install wizard
// ---------------------------------------------------------------------------

type WizardStep = "target_manager" | "source_policy" | "skill_plan" | "preview";

const STEP_LABELS: Record<WizardStep, string> = {
  target_manager: "Target manager",
  source_policy: "Source policy",
  skill_plan: "Prerequisite skills",
  preview: "Preview",
};

// `simplified` is the onboarding seam (design §6): the newly created company is
// treated as a full-company-equivalent target, so the target-manager step is
// dropped and source policy is never surfaced (onboarding only offers
// markdown_only/assets teams). The skill plan collapses to a count and the
// preview is minimal, but the skill step still renders when required skills
// exist so resolution stays honest.
function computeSteps(team: CatalogTeam, simplified = false): WizardStep[] {
  const steps: WizardStep[] = [];
  if (!simplified && team.rootAgentSlugs.length > 0) steps.push("target_manager");
  if (!simplified && team.sourceRefs.some((s) => sourceWarningCode(s) !== "ok")) {
    steps.push("source_policy");
  }
  if (team.requiredSkills.length > 0) steps.push("skill_plan");
  steps.push("preview");
  return steps;
}

type ApplyPhase = "form" | "applying" | "done" | "error";

// ---------------------------------------------------------------------------
// Install hook — the onboarding seam (design §6 + §12.5).
//
// `useInstallTeamCatalogEntry` owns the preview/install engine: option building,
// the two API mutations, and the resolved result/phase state. The installer
// dialog drives it with operator-entered form state; a future onboarding step
// can drive the same hook with `{ simplified: true }` and default form state to
// run the collapsed, no-target-manager flow without any UI rework.
// ---------------------------------------------------------------------------

export interface TeamInstallFormState {
  targetManagerAgentId: string | null;
  fullCompany: boolean;
  allowExternalSources: boolean;
  allowUnpinnedOptionalSources: boolean;
  allowLocalPathSources: boolean;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  /** slug -> renamed entity name */
  nameOverrides: Record<string, string>;
  /** slug -> adapterType override */
  adapterOverrides: Record<string, string>;
  /** scoped env input key -> operator-entered value */
  secretValues: Record<string, string>;
}

export const EMPTY_INSTALL_FORM: TeamInstallFormState = {
  targetManagerAgentId: null,
  fullCompany: false,
  allowExternalSources: false,
  allowUnpinnedOptionalSources: false,
  allowLocalPathSources: false,
  collisionStrategy: "rename",
  nameOverrides: {},
  adapterOverrides: {},
  secretValues: {},
};

export interface UseInstallTeamCatalogEntryOptions {
  companyId: string;
  team: CatalogTeam;
  /**
   * Run the simplified onboarding flow: no target-manager step, source policy
   * never surfaced, collapsed preview. The company is treated as a
   * full-company-equivalent target (`targetManagerAgentId: null`).
   */
  simplified?: boolean;
  onInstalled?: (result: CatalogTeamInstallResult) => void;
}

export interface UseInstallTeamCatalogEntryResult {
  simplified: boolean;
  steps: WizardStep[];
  phase: ApplyPhase;
  setPhase: (phase: ApplyPhase) => void;
  previewResult: CatalogTeamImportPreviewResult | null;
  previewError: string | null;
  isPreviewing: boolean;
  installResult: CatalogTeamInstallResult | null;
  applyError: string | null;
  runPreview: (form: TeamInstallFormState) => void;
  runInstall: (form: TeamInstallFormState) => void;
  buildPreviewOptions: (form: TeamInstallFormState) => CatalogTeamImportOptions;
  buildInstallOptions: (form: TeamInstallFormState) => CatalogTeamInstallOptions;
  reset: () => void;
}

export function useInstallTeamCatalogEntry({
  companyId,
  team,
  simplified = false,
  onInstalled,
}: UseInstallTeamCatalogEntryOptions): UseInstallTeamCatalogEntryResult {
  const [phase, setPhase] = useState<ApplyPhase>("form");
  const [previewResult, setPreviewResult] = useState<CatalogTeamImportPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<CatalogTeamInstallResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const steps = useMemo(() => computeSteps(team, simplified), [team, simplified]);

  // Preview body — the preview schema is strict and does NOT accept adapterOverrides.
  const buildPreviewOptions = useCallback(
    (form: TeamInstallFormState): CatalogTeamImportOptions => ({
      targetManagerAgentId: simplified || form.fullCompany ? null : form.targetManagerAgentId,
      collisionStrategy: form.collisionStrategy,
      nameOverrides:
        Object.keys(form.nameOverrides).length > 0 ? form.nameOverrides : undefined,
      sourcePolicy: {
        allowExternalSources: form.allowExternalSources,
        allowUnpinnedOptionalSources: form.allowUnpinnedOptionalSources,
        allowLocalPathSources: form.allowLocalPathSources,
      },
    }),
    [simplified],
  );

  // Install body extends the preview body with adapterOverrides.
  const buildInstallOptions = useCallback(
    (form: TeamInstallFormState): CatalogTeamInstallOptions => {
      const overrides: Record<string, CompanyPortabilityAdapterOverride> = {};
      for (const [slug, adapterType] of Object.entries(form.adapterOverrides)) {
        if (adapterType) overrides[slug] = { adapterType };
      }
      return {
        ...buildPreviewOptions(form),
        adapterOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        secretValues: Object.keys(form.secretValues).length > 0 ? form.secretValues : undefined,
      };
    },
    [buildPreviewOptions],
  );

  const previewMutation = useMutation({
    mutationFn: (form: TeamInstallFormState) =>
      teamCatalogApi.preview(companyId, team.id, buildPreviewOptions(form)),
    onSuccess: (result) => {
      setPreviewResult(result);
      setPreviewError(null);
    },
    onError: (error) => {
      setPreviewError(error instanceof Error ? error.message : "Failed to load install preview.");
    },
  });

  const installMutation = useMutation({
    mutationFn: (form: TeamInstallFormState) =>
      teamCatalogApi.install(companyId, team.id, buildInstallOptions(form)),
    onMutate: () => {
      setPhase("applying");
      setApplyError(null);
    },
    onSuccess: (result) => {
      setInstallResult(result);
      setPhase("done");
      onInstalled?.(result);
    },
    onError: (error) => {
      setPhase("error");
      setApplyError(error instanceof Error ? error.message : "Install failed.");
    },
  });

  const reset = useCallback(() => {
    setPhase("form");
    setPreviewResult(null);
    setPreviewError(null);
    setInstallResult(null);
    setApplyError(null);
  }, []);

  return {
    simplified,
    steps,
    phase,
    setPhase,
    previewResult,
    previewError,
    isPreviewing: previewMutation.isPending,
    installResult,
    applyError,
    runPreview: previewMutation.mutate,
    runInstall: installMutation.mutate,
    buildPreviewOptions,
    buildInstallOptions,
    reset,
  };
}

function TeamInstallerDialog({
  team,
  companyId,
  agents,
  open,
  onClose,
  onInstalled,
}: {
  team: CatalogTeam;
  companyId: string;
  agents: Agent[];
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const steps = useMemo(() => computeSteps(team), [team]);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<ApplyPhase>("form");

  // Step 1 — target manager
  const [targetManagerAgentId, setTargetManagerAgentId] = useState<string | null>(null);
  const [fullCompany, setFullCompany] = useState(false);
  const canBypassManager = team.recommendedForCompanyTypes.includes("company-root");

  // Step 2 — source policy (the strict API exposes 3 booleans)
  const [allowExternalSources, setAllowExternalSources] = useState(false);
  const [allowUnpinnedOptionalSources, setAllowUnpinnedOptionalSources] = useState(false);
  const [allowLocalPathSources, setAllowLocalPathSources] = useState(false);

  // Step 4 — preview controls
  const [collisionStrategy, setCollisionStrategy] = useState<CompanyPortabilityCollisionStrategy>("rename");
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  // slug -> adapterType override (the install schema accepts adapterOverrides).
  const [adapterOverrides, setAdapterOverrides] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [visibleSecretKeys, setVisibleSecretKeys] = useState<Record<string, boolean>>({});
  const [confirmScripts, setConfirmScripts] = useState(false);

  const [previewResult, setPreviewResult] = useState<CatalogTeamImportPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<CatalogTeamInstallResult | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setStepIndex(0);
      setPhase("form");
      setTargetManagerAgentId(null);
      setFullCompany(false);
      setAllowExternalSources(false);
      setAllowUnpinnedOptionalSources(false);
      setAllowLocalPathSources(false);
      setCollisionStrategy("rename");
      setNameOverrides({});
      setAdapterOverrides({});
      setSecretValues({});
      setVisibleSecretKeys({});
      setConfirmScripts(false);
      setPreviewResult(null);
      setPreviewError(null);
      setApplyError(null);
      setInstallResult(null);
    }
  }, [open]);

  const currentStep = steps[stepIndex];

  // Preview body — the preview schema is strict and does NOT accept adapterOverrides.
  const buildPreviewOptions = () => ({
    targetManagerAgentId: fullCompany ? null : targetManagerAgentId,
    collisionStrategy,
    nameOverrides: Object.keys(nameOverrides).length > 0 ? nameOverrides : undefined,
    sourcePolicy: {
      allowExternalSources,
      allowUnpinnedOptionalSources,
      allowLocalPathSources,
    },
  });

  // Install body extends the preview body with adapterOverrides.
  const buildInstallOptions = () => {
    const overrides: Record<string, CompanyPortabilityAdapterOverride> = {};
    for (const [slug, adapterType] of Object.entries(adapterOverrides)) {
      if (adapterType) overrides[slug] = { adapterType };
    }
    const enteredSecretValues = Object.fromEntries(
      Object.entries(secretValues).filter(([, value]) => value.trim().length > 0),
    );
    return {
      ...buildPreviewOptions(),
      adapterOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      secretValues: Object.keys(enteredSecretValues).length > 0 ? enteredSecretValues : undefined,
    };
  };

  const previewMutation = useMutation({
    mutationFn: () => teamCatalogApi.preview(companyId, team.id, buildPreviewOptions()),
    onSuccess: (result) => {
      setPreviewResult(result);
      setPreviewError(null);
    },
    onError: (error) => {
      setPreviewError(error instanceof Error ? error.message : "Failed to load install preview.");
    },
  });

  const installMutation = useMutation({
    mutationFn: () => teamCatalogApi.install(companyId, team.id, buildInstallOptions()),
    onMutate: () => {
      setPhase("applying");
      setApplyError(null);
    },
    onSuccess: (result) => {
      setInstallResult(result);
      setPhase("done");
      onInstalled();
    },
    onError: (error) => {
      setPhase("error");
      setApplyError(error instanceof Error ? error.message : "Install failed.");
    },
  });

  // Auto-load preview when reaching the preview step.
  const previewRequested = useRef(false);
  useEffect(() => {
    if (currentStep === "preview" && !previewRequested.current && !previewMutation.isPending) {
      previewRequested.current = true;
      previewMutation.mutate();
    }
    if (currentStep !== "preview") previewRequested.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  const targetManagerResolved = fullCompany || Boolean(targetManagerAgentId);

  function canContinue(step: WizardStep): boolean {
    if (step === "target_manager") return targetManagerResolved;
    if (step === "source_policy") {
      // Block forward when an unsupported source is present and not (cannot be) allowed.
      const hasUnsupported = team.sourceRefs.some((s) => sourceWarningCode(s) === "unsupported_in_ui");
      if (hasUnsupported && !allowLocalPathSources) return false;
      return true;
    }
    return true;
  }

  const hasErrors = (previewResult?.errors.length ?? 0) > 0;
  const blockedCount = previewResult?.errors.length ?? 0;
  const missingRequiredSecretInputs = (previewResult?.portabilityPreview.envInputs ?? [])
    .filter((input) => input.requirement === "required" && (secretValues[envInputFormKey(input)] ?? "").trim().length === 0);
  const missingRequiredSecretCount = missingRequiredSecretInputs.length;
  const installBlocked = hasErrors || missingRequiredSecretCount > 0;
  const needsScriptsConfirm = team.trustLevel === "scripts_executables";

  function goNext() {
    if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
  }
  function goBack() {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }

  function submitInstall() {
    if (needsScriptsConfirm && !confirmScripts) {
      setConfirmScripts(true);
      return;
    }
    installMutation.mutate();
  }

  const totalSteps = steps.length;
  const isMobileSheet = useMediaQuery(`(max-width: ${MOBILE_MAX}px)`);

  const headerTitle = (
    <span className="flex items-center gap-2">
      <Users2 className="h-4 w-4" />
      Install {team.name}
    </span>
  );
  const headerDescription =
    phase === "form" ? (
      <span className="flex items-center gap-2">
        <span>
          Step {stepIndex + 1} of {totalSteps} · {STEP_LABELS[currentStep]}
        </span>
        <span className="flex items-center gap-1" aria-hidden>
          {steps.map((s, i) => (
            <span
              key={s}
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                i === stepIndex ? "bg-primary" : i < stepIndex ? "bg-primary/50" : "bg-muted",
              )}
            />
          ))}
        </span>
      </span>
    ) : null;

  const body = (
    <>
        {phase === "form" && (
          <div className="space-y-4 overflow-auto pr-1 md:max-h-(--sz-60vh)">
            {currentStep === "target_manager" && (
              <StepTargetManager
                team={team}
                agents={agents}
                targetManagerAgentId={targetManagerAgentId}
                onPickManager={(id) => { setTargetManagerAgentId(id); setFullCompany(false); }}
                fullCompany={fullCompany}
                onToggleFullCompany={(v) => { setFullCompany(v); if (v) setTargetManagerAgentId(null); }}
                canBypassManager={canBypassManager}
              />
            )}

            {currentStep === "source_policy" && (
              <StepSourcePolicy
                team={team}
                allowExternalSources={allowExternalSources}
                allowUnpinnedOptionalSources={allowUnpinnedOptionalSources}
                allowLocalPathSources={allowLocalPathSources}
                onChange={(key, value) => {
                  if (key === "external") setAllowExternalSources(value);
                  if (key === "unpinned") setAllowUnpinnedOptionalSources(value);
                  if (key === "localPath") setAllowLocalPathSources(value);
                }}
              />
            )}

            {currentStep === "skill_plan" && (
              <StepSkillPlan team={team} preparations={previewResult?.skillPreparations ?? null} />
            )}

            {currentStep === "preview" && (
              <StepPreview
                team={team}
                loading={previewMutation.isPending}
                error={previewError}
                result={previewResult}
                collisionStrategy={collisionStrategy}
                onCollisionStrategyChange={(s) => { setCollisionStrategy(s); previewRequested.current = false; previewMutation.mutate(); }}
                nameOverrides={nameOverrides}
                onRename={(slug, name) => setNameOverrides((cur) => ({ ...cur, [slug]: name }))}
                adapterOverrides={adapterOverrides}
                onAdapterChange={(slug, adapterType) => setAdapterOverrides((cur) => ({ ...cur, [slug]: adapterType }))}
                secretValues={secretValues}
                visibleSecretKeys={visibleSecretKeys}
                onSecretChange={(key, value) => setSecretValues((cur) => ({ ...cur, [key]: value }))}
                onToggleSecretVisibility={(key) => setVisibleSecretKeys((cur) => ({ ...cur, [key]: !cur[key] }))}
                onRetry={() => previewMutation.mutate()}
              />
            )}
          </div>
        )}

        {phase === "applying" && <ApplyProgress team={team} />}
        {phase === "done" && <ApplySuccess team={team} result={installResult} onClose={onClose} />}
        {phase === "error" && (
          <div className="space-y-3">
            <div role="alert" className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-300">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Install failed</p>
                <p className="mt-0.5 text-xs">{applyError}</p>
                <p className="mt-1 text-xs opacity-80">
                  Partial state is not rolled back. Review the company activity log before retrying.
                </p>
              </div>
            </div>
          </div>
        )}
    </>
  );

  const footer =
    phase === "form" ? (
      <div className="flex items-center justify-between gap-3">
        <div>
          {stepIndex > 0 ? (
            <Button variant="ghost" onClick={goBack}>Back</Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {currentStep === "preview" && hasErrors && (
            <span className="text-xs text-rose-600 dark:text-rose-300">
              Install blocked: {blockedCount} error{blockedCount === 1 ? "" : "s"}
            </span>
          )}
          {currentStep === "preview" && !hasErrors && missingRequiredSecretCount > 0 && (
            <span className="text-xs text-rose-600 dark:text-rose-300">
              Required secrets missing: {missingRequiredSecretCount}
            </span>
          )}
          {currentStep === "preview" ? (
            needsScriptsConfirm && confirmScripts ? (
              <Button variant="destructive" onClick={submitInstall} disabled={installBlocked || previewMutation.isPending}>
                <AlertTriangle className="h-4 w-4" />
                Confirm — install with executables
              </Button>
            ) : (
              <Button onClick={submitInstall} disabled={installBlocked || previewMutation.isPending || !previewResult}>
                {needsScriptsConfirm ? <AlertTriangle className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                {needsScriptsConfirm ? "Install with executables" : "Install team"}
              </Button>
            )
          ) : (
            <Button onClick={goNext} disabled={!canContinue(currentStep)}>Continue</Button>
          )}
        </div>
      </div>
    ) : phase === "error" ? (
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    ) : null;

  const dismissable = phase !== "applying";

  // <768px → full-height Sheet with sticky footer (design §11); otherwise Dialog.
  if (isMobileSheet) {
    return (
      <Sheet open={open} onOpenChange={(next) => { if (!next && dismissable) onClose(); }}>
        <SheetContent side="bottom" className="flex h-(--sz-100dvh) flex-col gap-0 p-0">
          <SheetHeader className="border-b border-border">
            <SheetTitle>{headerTitle}</SheetTitle>
            {headerDescription && <SheetDescription>{headerDescription}</SheetDescription>}
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto p-4">{body}</div>
          {footer && <div className="border-t border-border bg-background p-4">{footer}</div>}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && dismissable) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{headerTitle}</DialogTitle>
          {headerDescription && <DialogDescription>{headerDescription}</DialogDescription>}
        </DialogHeader>
        {body}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export function StepTargetManager({
  team,
  agents,
  targetManagerAgentId,
  onPickManager,
  fullCompany,
  onToggleFullCompany,
  canBypassManager,
}: {
  team: CatalogTeam;
  agents: Agent[];
  targetManagerAgentId: string | null;
  onPickManager: (id: string) => void;
  fullCompany: boolean;
  onToggleFullCompany: (v: boolean) => void;
  canBypassManager: boolean;
}) {
  return (
    <div className="space-y-4">
      <div
        className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2.5 text-sm text-blue-700 dark:text-blue-300"
        id="target-manager-help"
      >
        This team&apos;s root agents need a manager in your company. Pick the agent who will become
        their parent. Internal team hierarchy is preserved.
      </div>

      <div className="space-y-1.5">
        <SectionHeader>Root agents</SectionHeader>
        <ul className="rounded-md border border-border">
          {team.rootAgentSlugs.map((slug) => (
            <li key={slug} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-b-0">
              <Crown className="h-3.5 w-3.5 text-amber-500" />
              <span className="font-medium">{titleCase(slug)}</span>
              <Badge variant="ghost" className="ml-auto bg-amber-500/15 text-(length:--text-micro) text-amber-600 dark:text-amber-300">
                → ?
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      {!fullCompany && (
        <div className="space-y-1.5" aria-describedby="target-manager-help">
          <SectionHeader>Target manager</SectionHeader>
          <Command className="rounded-md border border-border">
            <CommandInput placeholder="Search agents…" />
            <CommandList>
              <CommandEmpty>No agents found.</CommandEmpty>
              <CommandGroup>
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={`${agent.name} ${agent.role} ${agent.title ?? ""}`}
                    onSelect={() => onPickManager(agent.id)}
                  >
                    <div className="flex w-full items-center gap-2">
                      <Users2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">{agent.name}</span>
                      <span className="text-xs text-muted-foreground capitalize">{agent.role}</span>
                      {targetManagerAgentId === agent.id && <Check className="ml-auto h-4 w-4 text-emerald-500" />}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}

      {canBypassManager && (
        <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <input
            type="radio"
            checked={fullCompany}
            onChange={(e) => onToggleFullCompany(e.target.checked)}
          />
          Use this team as a full-company package (no target manager)
        </label>
      )}
    </div>
  );
}

export function StepSourcePolicy({
  team,
  allowExternalSources,
  allowUnpinnedOptionalSources,
  allowLocalPathSources,
  onChange,
}: {
  team: CatalogTeam;
  allowExternalSources: boolean;
  allowUnpinnedOptionalSources: boolean;
  allowLocalPathSources: boolean;
  onChange: (key: "external" | "unpinned" | "localPath", value: boolean) => void;
}) {
  const external = team.sourceRefs.filter((s) => s.type !== "include");
  const hasUnsupported = external.some((s) => sourceWarningCode(s) === "unsupported_in_ui");
  return (
    <div className="space-y-4">
      <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
        This team references {external.length} external source{external.length === 1 ? "" : "s"}.
        Review each one and decide what to allow before continuing.
      </div>

      <ul className="divide-y divide-border rounded-md border border-border">
        {external.map((source) => {
          const Icon = sourceKindIcon(source.type);
          const code = sourceWarningCode(source);
          return (
            <li key={`${source.type}:${source.ref}`} className="flex items-center gap-2 px-3 py-2.5 text-sm">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-mono text-xs truncate">{source.ref}</p>
                <p className="text-(length:--text-micro) text-muted-foreground">
                  {code === "ok" && "pinned"}
                  {code === "unpinned" && "unpinned reference"}
                  {code === "unsupported_in_ui" && "not installable from the browser"}
                </p>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "ml-auto text-(length:--text-nano)",
                  code === "unsupported_in_ui"
                    ? "text-rose-600 dark:text-rose-300 border-rose-500/30"
                    : code === "unpinned"
                      ? "text-amber-600 dark:text-amber-300 border-amber-500/30"
                      : "text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
                )}
              >
                {source.type}
              </Badge>
            </li>
          );
        })}
      </ul>

      <div className="space-y-2.5 rounded-md border border-border p-3">
        <PolicyToggle
          label="Allow external sources"
          description="Resolve github/url skill and team sources at install time."
          checked={allowExternalSources}
          onChange={(v) => onChange("external", v)}
        />
        <PolicyToggle
          label="Allow unpinned optional sources"
          description="Permit optional sources that are not pinned to a ref or checksum."
          checked={allowUnpinnedOptionalSources}
          onChange={(v) => onChange("unpinned", v)}
        />
        <PolicyToggle
          label="Allow local-path sources"
          description="Required for local_path / agent_package sources. Development use only."
          checked={allowLocalPathSources}
          onChange={(v) => onChange("localPath", v)}
        />
      </div>

      {hasUnsupported && !allowLocalPathSources && (
        <p className="text-xs text-rose-600 dark:text-rose-300">
          This team has local-path sources. Enable &ldquo;Allow local-path sources&rdquo; to continue,
          or install it from the CLI.
        </p>
      )}
    </div>
  );
}

function PolicyToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ToggleSwitch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const SKILL_ACTION_META: Record<
  CatalogTeamSkillPreparation["action"],
  { label: string; tone: string }
> = {
  already_in_package: { label: "Bundled in package", tone: "text-emerald-600 dark:text-emerald-300 border-emerald-500/30" },
  catalog_install_required: { label: "Will install from catalog", tone: "text-blue-600 dark:text-blue-300 border-blue-500/30" },
  external_import_required: { label: "Will import from source", tone: "text-amber-600 dark:text-amber-300 border-amber-500/30" },
  blocked: { label: "Blocked", tone: "text-rose-600 dark:text-rose-300 border-rose-500/30" },
};

export function StepSkillPlan({
  team,
  preparations,
}: {
  team: CatalogTeam;
  preparations: CatalogTeamSkillPreparation[] | null;
}) {
  // Use the live preparations when a preview has run; otherwise fall back to the
  // static required-skill list (read-only — the strict API does not accept a
  // per-skill plan override, design §7 graceful degradation).
  return (
    <div className="space-y-4">
      <div role="alert" className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2.5 text-sm text-blue-700 dark:text-blue-300">
        Before agents are imported, the catalog resolves the skills they depend on. This is the
        resolution plan.
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {(preparations ?? team.requiredSkills.map(toPreparation)).map((prep) => {
          const meta = SKILL_ACTION_META[prep.action];
          return (
            <li key={`${prep.type}:${prep.ref}`} className="flex items-center gap-2 px-3 py-2.5 text-sm">
              <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-mono text-xs truncate">{prep.ref}</p>
                {prep.reason && <p className="text-(length:--text-micro) text-muted-foreground">{prep.reason}</p>}
              </div>
              <Badge variant="outline" className={cn("ml-auto text-(length:--text-nano)", meta.tone)}>
                {meta.label}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function toPreparation(skill: CatalogTeamSkillRequirement): CatalogTeamSkillPreparation {
  return {
    type: skill.type,
    ref: skill.ref,
    agentSlugs: skill.agentSlugs,
    action:
      skill.type === "catalog"
        ? "catalog_install_required"
        : skill.resolved
          ? "already_in_package"
          : "external_import_required",
    catalogSkillId: skill.catalogSkillId ?? null,
    catalogSkillKey: skill.catalogSkillKey ?? null,
    sourceLocator: skill.sourceLocator ?? null,
    sourceRef: skill.sourceRef ?? null,
    reason: null,
  };
}

const PLAN_ACTION_TONE: Record<string, string> = {
  create: "text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  update: "text-amber-600 dark:text-amber-300 border-amber-500/30",
  skip: "text-muted-foreground border-border",
};

function PlanRow({
  slug,
  action,
  plannedName,
  reason,
  canRename,
  override,
  onRename,
}: {
  slug: string;
  action: string;
  plannedName: string;
  reason: string | null;
  canRename: boolean;
  override?: string;
  onRename?: (slug: string, name: string) => void;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      <Badge variant="outline" className={cn("text-(length:--text-nano) uppercase", PLAN_ACTION_TONE[action] ?? "border-border")}>
        {action}
      </Badge>
      <span className={cn("font-mono text-xs", action === "skip" && "line-through opacity-60")}>{slug}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      {canRename && onRename ? (
        <Input
          value={override ?? plannedName}
          onChange={(e) => onRename(slug, e.target.value)}
          className="h-7 max-w-(--sz-14rem) font-mono text-xs"
        />
      ) : (
        <span className="font-mono text-xs">{plannedName}</span>
      )}
      {reason && <span className="ml-auto text-(length:--text-micro) text-muted-foreground">{reason}</span>}
    </li>
  );
}

export function StepPreview({
  team,
  loading,
  error,
  result,
  collisionStrategy,
  onCollisionStrategyChange,
  nameOverrides,
  onRename,
  adapterOverrides,
  onAdapterChange,
  secretValues = {},
  visibleSecretKeys = {},
  onSecretChange = () => {},
  onToggleSecretVisibility = () => {},
  onRetry,
}: {
  team: CatalogTeam;
  loading: boolean;
  error: string | null;
  result: CatalogTeamImportPreviewResult | null;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  onCollisionStrategyChange: (s: CompanyPortabilityCollisionStrategy) => void;
  nameOverrides: Record<string, string>;
  onRename: (slug: string, name: string) => void;
  adapterOverrides: Record<string, string>;
  onAdapterChange: (slug: string, adapterType: string) => void;
  secretValues?: Record<string, string>;
  visibleSecretKeys?: Record<string, boolean>;
  onSecretChange?: (key: string, value: string) => void;
  onToggleSecretVisibility?: (key: string) => void;
  onRetry: () => void;
}) {
  if (loading && !result) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Preparing preview…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3">
        <div role="alert" className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-300">
          <XOctagon className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
        <Button variant="outline" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }
  if (!result) return null;

  const plan = result.portabilityPreview.plan;
  const envInputs = result.portabilityPreview.envInputs;
  const manifestAgents = result.portabilityPreview.manifest.agents;
  const canRename = collisionStrategy === "rename";

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="space-y-2">
        <SectionHeader>Summary</SectionHeader>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <SummaryCount label="Agents" value={plan.agentPlans.length} />
          <SummaryCount label="Projects" value={plan.projectPlans.length} />
          <SummaryCount label="Starter tasks" value={plan.issuePlans.length} />
          <SummaryCount label="Required skills" value={result.skillPreparations.length} />
        </div>
      </div>

      {/* Collision strategy */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Collision strategy</span>
        <Select value={collisionStrategy} onValueChange={(v) => onCollisionStrategyChange(v as CompanyPortabilityCollisionStrategy)}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rename">Rename collisions</SelectItem>
            <SelectItem value="skip">Skip collisions</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Errors / warnings */}
      {result.errors.length > 0 && (
        <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-300">
          <p className="font-medium">Install blocked</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
            {result.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          <ul className="list-disc space-y-0.5 pl-4">
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* Agents */}
      {plan.agentPlans.length > 0 && (
        <PreviewSection title={`Agents · ${plan.agentPlans.length}`}>
          {plan.agentPlans.map((p) => (
            <PlanRow
              key={p.slug}
              slug={p.slug}
              action={p.action}
              plannedName={p.plannedName}
              reason={p.reason}
              canRename={canRename && p.action !== "skip"}
              override={nameOverrides[p.slug]}
              onRename={onRename}
            />
          ))}
        </PreviewSection>
      )}

      {/* Projects */}
      {plan.projectPlans.length > 0 && (
        <PreviewSection title={`Projects · ${plan.projectPlans.length}`}>
          {plan.projectPlans.map((p) => (
            <PlanRow
              key={p.slug}
              slug={p.slug}
              action={p.action}
              plannedName={p.plannedName}
              reason={p.reason}
              canRename={canRename && p.action !== "skip"}
              override={nameOverrides[p.slug]}
              onRename={onRename}
            />
          ))}
        </PreviewSection>
      )}

      {/* Starter tasks */}
      {plan.issuePlans.length > 0 && (
        <PreviewSection title={`Starter tasks · ${plan.issuePlans.length}`}>
          {plan.issuePlans.map((p) => (
            <PlanRow key={p.slug} slug={p.slug} action={p.action} plannedName={p.plannedTitle} reason={p.reason} canRename={false} />
          ))}
        </PreviewSection>
      )}

      {/* Adapter selection — install schema accepts adapterOverrides (design §4.4) */}
      {manifestAgents.length > 0 && (
        <PreviewSection title={`Adapter selection · ${manifestAgents.length}`}>
          {manifestAgents.map((agent) => {
            const selected = adapterOverrides[agent.slug] ?? agent.adapterType;
            return (
              <li key={agent.slug} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="min-w-0 truncate">{agent.name}</span>
                <span className="font-mono text-(length:--text-micro) text-muted-foreground">{agent.slug}</span>
                <Select value={selected} onValueChange={(v) => onAdapterChange(agent.slug, v)}>
                  <SelectTrigger className="ml-auto h-8 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_ADAPTER_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>{getAdapterLabel(type)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            );
          })}
          <li className="px-3 py-1.5 text-(length:--text-micro) text-muted-foreground">
            Each imported agent defaults to its package adapter; override here before install.
            Deeper per-adapter model config is editable on the agent after install.
          </li>
        </PreviewSection>
      )}

      {/* Env inputs */}
      {envInputs.length > 0 && (
        <PreviewSection title={`Secrets & env inputs · ${envInputs.length}`}>
          {envInputs.map((input) => {
            const formKey = envInputFormKey(input);
            const visible = Boolean(visibleSecretKeys[formKey]);
            const missingRequired = input.requirement === "required" && (secretValues[formKey] ?? "").trim().length === 0;
            return (
              <li key={formKey} className="grid gap-2 px-3 py-2 text-sm sm:grid-cols-(--gtc-56) sm:items-center">
                <div className="flex min-w-0 items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-xs uppercase tracking-wide">{input.key}</span>
                  {input.description && <span className="truncate text-xs text-muted-foreground">{input.description}</span>}
                  {input.requirement === "required" && (
                    <Badge variant="outline" className="text-(length:--text-nano)">required</Badge>
                  )}
                  <Badge
                    variant="outline"
                    className={cn("ml-auto text-(length:--text-nano)", input.kind === "secret" ? "text-rose-600 dark:text-rose-300 border-rose-500/30" : "text-muted-foreground")}
                  >
                    {input.kind}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    type={visible ? "text" : "password"}
                    value={secretValues[formKey] ?? ""}
                    onChange={(event) => onSecretChange(formKey, event.target.value)}
                    placeholder={input.requirement === "required" ? "Required" : "Optional"}
                    aria-label={`${input.key} value`}
                    aria-invalid={missingRequired || undefined}
                    className={cn("h-8 min-w-0", missingRequired && "border-rose-500/60 focus-visible:ring-rose-500/30")}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="h-8 w-8"
                        onClick={() => onToggleSecretVisibility(formKey)}
                        aria-label={visible ? `Hide ${input.key}` : `Show ${input.key}`}
                      >
                        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{visible ? "Hide value" : "Show value"}</TooltipContent>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </PreviewSection>
      )}

      {/* Provenance */}
      <div className="rounded-md border border-border px-3 py-2.5 text-xs text-muted-foreground">
        Imported entities are stamped with <code className="font-mono">metadata.paperclip.catalogTeam</code>{" "}
        ({team.packageName ?? team.key}, content hash <code className="font-mono">{team.contentHash.slice(0, 16)}…</code>),
        and an activity event is recorded for preview and install.
      </div>
    </div>
  );
}

function SummaryCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function PreviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="divide-y divide-border/60">{children}</ul>
    </div>
  );
}

// The install API is a single non-streaming POST, so we cannot show truthful
// per-step progress mid-flight. Show one honest in-flight row; the resolved
// per-category checklist is rendered from the real result on the success screen.
export function ApplyProgress({ team }: { team: CatalogTeam }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <div>
        <p className="font-medium">Installing {team.name}…</p>
        <p className="text-xs text-muted-foreground">
          Resolving skills, importing agents, projects, and routines. This may take a moment.
        </p>
      </div>
    </div>
  );
}

function ResultRow({ label, count }: { label: string; count: number }) {
  return (
    <li className="flex items-center gap-2.5 py-1.5 text-sm">
      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      <span>{label}</span>
      <span className="ml-auto font-mono tabular-nums text-muted-foreground">{count}</span>
    </li>
  );
}

export function ApplySuccess({
  team,
  result,
  onClose,
}: {
  team: CatalogTeam;
  result: CatalogTeamInstallResult | null;
  onClose: () => void;
}) {
  const imp = result?.portabilityImport;
  const agentsCreated = imp?.agents.filter((a) => a.action !== "skipped").length ?? 0;
  const projectsCreated = imp?.projects.filter((p) => p.action !== "skipped").length ?? 0;
  const skillsResolved = result?.skillPreparations.length ?? 0;
  const warnings = result?.warnings ?? [];
  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        <p className="text-base font-semibold">Team installed</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {team.name} was imported into your company. Imported entities are stamped with catalog provenance.
      </p>
      {result && (
        <ul className="divide-y divide-border/60 rounded-md border border-border px-3">
          <ResultRow label="Agents imported" count={agentsCreated} />
          <ResultRow label="Projects imported" count={projectsCreated} />
          <ResultRow label="Skills resolved" count={skillsResolved} />
        </ul>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <ul className="list-disc space-y-0.5 pl-4">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      <ul className="space-y-1 text-sm">
        <li><a className="text-primary hover:underline" href="/agents/all">View imported agents →</a></li>
        <li><a className="text-primary hover:underline" href="/projects">View imported projects →</a></li>
        <li><a className="text-primary hover:underline" href="/routines">View routines →</a></li>
        <li><a className="text-primary hover:underline" href="/activity">View activity log →</a></li>
      </ul>
      <div className="flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse list
// ---------------------------------------------------------------------------

export function TeamRow({
  team,
  selected,
  onSelect,
  installed,
}: {
  team: CatalogTeam;
  selected: boolean;
  onSelect: () => void;
  installed?: InstalledCatalogTeam | null;
}) {
  const risk = teamRisk(team);
  const outOfDate = Boolean(installed?.outOfDate);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1 border-b border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-accent/30",
        selected && "bg-accent/40",
      )}
    >
      <div className="flex items-center gap-2">
        <Users2 className={cn("h-3.5 w-3.5 text-muted-foreground", team.kind === "optional" && "opacity-70")} />
        <span className={cn("line-clamp-2 text-(length:--text-compact) font-medium", selected && "text-foreground")}>
          {team.name}
        </span>
        {outOfDate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label="Update available"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
              >
                <ChevronUp className="h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Update available — installed team is out of date</TooltipContent>
          </Tooltip>
        )}
        {risk !== "safe" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className={cn("ml-auto h-3.5 w-3.5", risk === "blocked" ? "text-rose-500" : "text-amber-500")} />
            </TooltipTrigger>
            <TooltipContent>Has external sources</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
        <span>
          {team.counts.agents}a · {team.counts.projects}p · {team.counts.routines}r · {skillCount(team)}s
        </span>
        <TrustChip level={team.trustLevel} iconOnly />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// TeamCard — square tile for the onboarding "Pick a starter team" grid
// (design §6 + §12.5). Rendered in a 3-col grid of `defaultInstall` bundled
// teams. Selection is owned by the parent (the onboarding step) so the same
// tile works for the future live flow without rework.
// ---------------------------------------------------------------------------

export function TeamCard({
  team,
  selected = false,
  onSelect,
}: {
  team: CatalogTeam;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        // design-allow(card-pattern): interactive <button> tile; Card renders a div and would break button semantics (C5a Run 3)
        "flex aspect-square w-full flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-ring",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background">
          <Users2 className="h-4 w-4 text-muted-foreground" />
        </span>
        {team.trustLevel !== "markdown_only" && <TrustChip level={team.trustLevel} iconOnly />}
      </div>

      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold leading-snug">{team.name}</h3>
        <p className="text-xs text-muted-foreground">
          {team.counts.agents} agent{team.counts.agents === 1 ? "" : "s"} ·{" "}
          {team.counts.projects} project{team.counts.projects === 1 ? "" : "s"} ·{" "}
          {team.counts.routines} routine{team.counts.routines === 1 ? "" : "s"}
        </p>
      </div>

      {team.description && (
        <p className="line-clamp-3 text-xs text-muted-foreground">{team.description}</p>
      )}

      {team.tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1">
          {team.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-(length:--text-nano)">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}

type KindFilter = "all" | "bundled" | "optional";
type RiskFilter = "any" | "safe" | "has_warnings" | "blocked";

function matchesSearch(team: CatalogTeam, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const haystack = [
    team.name,
    team.description,
    team.category,
    ...team.tags,
    ...team.agentSlugs,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function TeamCatalog() {
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const parsedRoute = useMemo(() => parseTeamRoute(routePath), [routePath]);
  const selectedRef = parsedRoute.catalogRef;
  const selectedFilePath = parsedRoute.filePath;

  const q = searchParams.get("search") ?? "";
  const kindFilter = (searchParams.get("kind") as KindFilter) ?? "all";
  const categoryFilter = searchParams.get("category") ?? "";
  const riskFilter = (searchParams.get("risk") as RiskFilter) ?? "any";

  // Preserve the active filter query (search/kind/category/risk) across in-page
  // navigation. Without this, auto-select and team-row / file-tree clicks rebuild
  // a fresh `/teams-catalog/<key>` path from `teamRoute()` and drop the query string, so a
  // landing `?search=…` unfiltered the list and emptied the search box (PAP-10257
  // follow-up). `applyCompanyPrefix` already preserves query strings.
  const filterQuery = searchParams.toString();
  const withFilters = useCallback(
    (path: string) => (filterQuery ? `${path}?${filterQuery}` : path),
    [filterQuery],
  );

  const [installOpen, setInstallOpen] = useState(false);
  const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Org Chart", href: "/org" },
      { label: "Teams", href: TEAM_CATALOG_ROUTE_ROOT },
    ]);
  }, [setBreadcrumbs]);

  const catalogQuery = useQuery({
    queryKey: queryKeys.teamCatalog.catalog({ kind: kindFilter === "all" ? undefined : kindFilter }),
    queryFn: () => teamCatalogApi.catalogList(kindFilter === "all" ? {} : { kind: kindFilter }),
    enabled: Boolean(selectedCompanyId),
  });

  const teams = catalogQuery.data ?? [];

  const categories = useMemo(
    () => Array.from(new Set(teams.map((t) => t.category))).sort(),
    [teams],
  );

  const filtered = useMemo(() => {
    return teams.filter((team) => {
      if (kindFilter !== "all" && team.kind !== kindFilter) return false;
      if (categoryFilter && team.category !== categoryFilter) return false;
      if (riskFilter !== "any" && teamRisk(team) !== riskFilter) return false;
      if (!matchesSearch(team, q)) return false;
      return true;
    });
  }, [teams, kindFilter, categoryFilter, riskFilter, q]);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedRef || t.key === selectedRef || t.slug === selectedRef) ?? null,
    [teams, selectedRef],
  );

  // Auto-select the first team when none is in the route — desktop only. On
  // narrow viewports the list stands alone until the operator picks a team
  // (design §11).
  useEffect(() => {
    if (isDesktop && !selectedRef && filtered[0]) {
      navigate(withFilters(teamRoute(filtered[0].id)), { replace: true });
    }
  }, [isDesktop, selectedRef, filtered, navigate, withFilters]);

  const fileQuery = useQuery({
    queryKey: queryKeys.teamCatalog.catalogFile(selectedTeam?.id ?? "", selectedFilePath ?? ""),
    queryFn: () => teamCatalogApi.catalogFile(selectedTeam!.id, selectedFilePath!),
    enabled: Boolean(selectedTeam && selectedFilePath),
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // Server-computed installed/out-of-date state. Drives the `INSTALLED · N`
  // group, the per-row out-of-date badge, and the detail header chip from a
  // real server signal (design §3.2 + §5 / PAP-10256).
  const installedQuery = useQuery({
    queryKey: queryKeys.teamCatalog.installed(selectedCompanyId ?? ""),
    queryFn: () => teamCatalogApi.installed(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledCatalogTeam>();
    for (const entry of installedQuery.data ?? []) {
      if (entry.present) map.set(entry.catalogId, entry);
    }
    return map;
  }, [installedQuery.data]);

  function setFilterParam(key: string, value: string | null) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null || value === "" || value === "all" || value === "any") next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  const anyFilterActive = q !== "" || kindFilter !== "all" || categoryFilter !== "" || riskFilter !== "any";

  // Installed teams collapse under a single `INSTALLED · N` group and drop out
  // of their BUNDLED/OPTIONAL home (design §5 "Already installed").
  const grouped = useMemo(() => {
    const installed = filtered.filter((t) => installedById.has(t.id));
    const remaining = filtered.filter((t) => !installedById.has(t.id));
    const bundled = remaining.filter((t) => t.kind === "bundled");
    const optional = remaining.filter((t) => t.kind === "optional");
    return { bundled, optional, installed };
  }, [filtered, installedById]);

  const canInstall = true; // server enforces; UI shows the affordance to operators

  if (!selectedCompanyId) {
    return (
      <div className="p-8">
        <EmptyState icon={Users2} message="Select a company to browse the team catalog." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <h1 className="text-lg font-semibold">Teams</h1>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setFilterParam("search", e.target.value)}
            placeholder="Search teams"
            className="h-8 w-56 pl-8"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <Filter className="h-3.5 w-3.5" />
              {kindFilter === "all" ? "All kinds" : kindFilter === "bundled" ? "Bundled" : "Optional"}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Kind</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={kindFilter} onValueChange={(v) => setFilterParam("kind", v)}>
              <DropdownMenuRadioItem value="all">All kinds</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="bundled">Bundled</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="optional">Optional</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {categories.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8">
                {categoryFilter ? `Category · ${titleCase(categoryFilter)}` : "All categories"}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Category</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={categoryFilter} onValueChange={(v) => setFilterParam("category", v)}>
                <DropdownMenuRadioItem value="">All categories</DropdownMenuRadioItem>
                {categories.map((cat) => (
                  <DropdownMenuRadioItem key={cat} value={cat}>{titleCase(cat)}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              {riskFilter === "any" ? "Any risk" : riskFilter === "safe" ? "Safe only" : riskFilter === "has_warnings" ? "Has warnings" : "Blocked"}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Risk</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={riskFilter} onValueChange={(v) => setFilterParam("risk", v)}>
              <DropdownMenuRadioItem value="any">Any risk</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="safe">Safe only</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="has_warnings">Has warnings</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="blocked">Blocked</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {anyFilterActive && (
              <>
                <DropdownMenuSeparator />
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSearchParams(new URLSearchParams())}
                >
                  <RotateCcw className="h-3 w-3" /> Reset filters
                </button>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {anyFilterActive && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setSearchParams(new URLSearchParams())}>
            Reset filters
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* List column — full width on < lg, fixed rail on >= lg (design §11) */}
        <div
          className={cn(
            "w-full overflow-auto border-r border-border lg:w-(--sz-28rem) lg:shrink-0",
            !isDesktop && selectedTeam && "hidden",
          )}
        >
          {catalogQuery.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : catalogQuery.isError ? (
            <div className="p-4">
              <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-300">
                Failed to load team catalog.
              </div>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => catalogQuery.refetch()}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          ) : teams.length === 0 ? (
            <EmptyState icon={Users2} message="No team catalog configured." />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              message="No teams match this filter."
              action="Reset filters"
              onAction={() => setSearchParams(new URLSearchParams())}
            />
          ) : (
            <div>
              {grouped.bundled.length > 0 && (
                <>
                  <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                    Bundled · {grouped.bundled.length}
                  </div>
                  {grouped.bundled.map((team) => (
                    <TeamRow
                      key={team.id}
                      team={team}
                      selected={team.id === selectedTeam?.id}
                      onSelect={() => navigate(withFilters(teamRoute(team.id)))}
                    />
                  ))}
                </>
              )}
              {grouped.optional.length > 0 && (
                <>
                  <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                    Optional · {grouped.optional.length}
                  </div>
                  {grouped.optional.map((team) => (
                    <TeamRow
                      key={team.id}
                      team={team}
                      selected={team.id === selectedTeam?.id}
                      onSelect={() => navigate(withFilters(teamRoute(team.id)))}
                    />
                  ))}
                </>
              )}
              {grouped.installed.length > 0 && (
                <>
                  <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                    Installed · {grouped.installed.length}
                  </div>
                  {grouped.installed.map((team) => (
                    <TeamRow
                      key={team.id}
                      team={team}
                      selected={team.id === selectedTeam?.id}
                      onSelect={() => navigate(withFilters(teamRoute(team.id)))}
                      installed={installedById.get(team.id) ?? null}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Detail pane — hidden on < lg until a team is selected (design §11) */}
        {(isDesktop || selectedTeam) && (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !isDesktop && !selectedTeam && "hidden",
            )}
          >
            {!isDesktop && selectedTeam && (
              <button
                type="button"
                onClick={() => navigate(withFilters(TEAM_CATALOG_ROUTE_ROOT))}
                className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" /> Back to catalog
              </button>
            )}
            {selectedTeam ? (
              <TeamDetailPane
                team={selectedTeam}
                selectedPath={selectedFilePath}
                onSelectFile={(path) =>
                  navigate(withFilters(path ? teamRoute(selectedTeam.id, path) : teamRoute(selectedTeam.id)))
                }
                onInstall={() => setInstallOpen(true)}
                canInstall={canInstall}
                fileContent={fileQuery.data?.content ?? null}
                installed={installedById.get(selectedTeam.id) ?? null}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a team to view details.
              </div>
            )}
          </div>
        )}
      </div>

      {selectedTeam && installOpen && (
        <TeamInstallerDialog
          team={selectedTeam}
          companyId={selectedCompanyId}
          agents={agentsQuery.data ?? []}
          open={installOpen}
          onClose={() => setInstallOpen(false)}
          onInstalled={() => {
            pushToast({ tone: "success", title: "Team installed", body: `${selectedTeam.name} was imported.` });
            // Provenance now lives on the new agents — refresh installed/out-of-date state.
            void queryClient.invalidateQueries({
              queryKey: queryKeys.teamCatalog.installed(selectedCompanyId),
            });
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
          }}
        />
      )}
    </div>
  );
}
