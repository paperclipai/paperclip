import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  Agent,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityManifest,
  Project,
} from "@paperclipai/shared";
import { useNavigate, useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { companiesApi } from "../api/companies";
import { projectsApi } from "../api/projects";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownBody } from "../components/MarkdownBody";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { createZipArchive } from "../lib/zip";
import { buildInitialExportCheckedFiles } from "../lib/company-export-selection";
import { useAgentOrder } from "../hooks/useAgentOrder";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { buildPortableSidebarOrder } from "../lib/company-portability-sidebar";
import { getPortableFileDataUrl, getPortableFileText, isPortableImageFile } from "../lib/portable-files";
import {
  Download,
  Package,
  Search,
} from "lucide-react";
import {
  type FileTreeNode,
  type FrontmatterData,
  buildFileTree,
  countFiles,
  collectAllPaths,
  parseFrontmatter,
  FRONTMATTER_FIELD_LABELS,
  FileTree,
} from "../components/FileTree";

/**
 * Extract the set of agent/project/task slugs that are "checked" based on
 * which file paths are in the checked set.
 *   agents/{slug}/AGENT.md   → agents slug
 *   projects/{slug}/PROJECT.md → projects slug
 *   tasks/{slug}/TASK.md     → tasks slug
 */
function checkedSlugs(checkedFiles: Set<string>): {
  agents: Set<string>;
  projects: Set<string>;
  tasks: Set<string>;
  routines: Set<string>;
} {
  const agents = new Set<string>();
  const projects = new Set<string>();
  const tasks = new Set<string>();
  for (const p of checkedFiles) {
    const agentMatch = p.match(/^agents\/([^/]+)\//);
    if (agentMatch) agents.add(agentMatch[1]);
    const projectMatch = p.match(/^projects\/([^/]+)\//);
    if (projectMatch) projects.add(projectMatch[1]);
    const taskMatch = p.match(/^tasks\/([^/]+)\//);
    if (taskMatch) tasks.add(taskMatch[1]);
  }
  return { agents, projects, tasks, routines: new Set(tasks) };
}

/**
 * Filter .paperclip.yaml content so it only includes entries whose
 * corresponding files are checked. Works by line-level YAML parsing
 * since the file has a known, simple structure produced by our own
 * renderYamlBlock.
 */
function filterPaperclipYaml(yaml: string, checkedFiles: Set<string>): string {
  const slugs = checkedSlugs(checkedFiles);
  const lines = yaml.split("\n");
  const out: string[] = [];

  // Sections whose entries are slug-keyed and should be filtered
  const filterableSections = new Set(["agents", "projects", "tasks", "routines"]);
  const sidebarSections = new Set(["agents", "projects"]);

  let currentSection: string | null = null; // top-level key (e.g. "agents")
  let currentEntry: string | null = null;   // slug under that section
  let includeEntry = true;
  let currentSidebarList: string | null = null;
  let currentSidebarHeaderLine: string | null = null;
  let currentSidebarBuffer: string[] = [];
  // Collect entries per section so we can omit empty section headers
  let sectionHeaderLine: string | null = null;
  let sectionBuffer: string[] = [];

  function flushSidebarSection() {
    if (currentSidebarHeaderLine !== null && currentSidebarBuffer.length > 0) {
      sectionBuffer.push(currentSidebarHeaderLine);
      sectionBuffer.push(...currentSidebarBuffer);
    }
    currentSidebarHeaderLine = null;
    currentSidebarBuffer = [];
  }

  function flushSection() {
    flushSidebarSection();
    if (sectionHeaderLine !== null && sectionBuffer.length > 0) {
      out.push(sectionHeaderLine);
      out.push(...sectionBuffer);
    }
    sectionHeaderLine = null;
    sectionBuffer = [];
  }

  for (const line of lines) {
    // Detect top-level key (no indentation)
    const topMatch = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (topMatch && !line.startsWith(" ")) {
      // Flush previous section
      flushSection();
      currentEntry = null;
      includeEntry = true;

      const key = topMatch[0].split(":")[0];
      if (filterableSections.has(key)) {
        currentSection = key;
        sectionHeaderLine = line;
        continue;
      } else if (key === "sidebar") {
        currentSection = key;
        currentSidebarList = null;
        sectionHeaderLine = line;
        continue;
      } else {
        currentSection = null;
        out.push(line);
        continue;
      }
    }

    if (currentSection === "sidebar") {
      const sidebarMatch = line.match(/^  ([\w-]+):\s*$/);
      if (sidebarMatch && !line.startsWith("    ")) {
        flushSidebarSection();
        const sidebarKey = sidebarMatch[1];
        currentSidebarList = sidebarKey && sidebarSections.has(sidebarKey) ? sidebarKey : null;
        currentSidebarHeaderLine = currentSidebarList ? line : null;
        continue;
      }

      const sidebarEntryMatch = line.match(/^    - ["']?([^"'\n]+)["']?\s*$/);
      if (sidebarEntryMatch && currentSidebarList) {
        const slug = sidebarEntryMatch[1];
        const sectionSlugs = slugs[currentSidebarList as keyof typeof slugs];
        if (slug && sectionSlugs.has(slug)) {
          currentSidebarBuffer.push(line);
        }
        continue;
      }

      if (currentSidebarList) {
        currentSidebarBuffer.push(line);
        continue;
      }
    }

    // Inside a filterable section
    if (currentSection && filterableSections.has(currentSection)) {
      // 2-space indented key = entry slug (slugs may start with digits/hyphens)
      const entryMatch = line.match(/^  ([\w][\w-]*):\s*(.*)$/);
      if (entryMatch && !line.startsWith("    ")) {
        const slug = entryMatch[1];
        currentEntry = slug;
        const sectionSlugs = slugs[currentSection as keyof typeof slugs];
        includeEntry = sectionSlugs.has(slug);
        if (includeEntry) sectionBuffer.push(line);
        continue;
      }

      // Deeper indented line belongs to current entry
      if (currentEntry !== null) {
        if (includeEntry) sectionBuffer.push(line);
        continue;
      }

      // Shouldn't happen in well-formed output, but pass through
      sectionBuffer.push(line);
      continue;
    }

    // Outside filterable sections — pass through
    out.push(line);
  }

  // Flush last section
  flushSection();

  let filtered = out.join("\n");
  const logoPathMatch = filtered.match(/^\s{2}logoPath:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (logoPathMatch && !checkedFiles.has(logoPathMatch[1]!)) {
    filtered = filtered.replace(/^\s{2}logoPath:\s*["']?([^"'\n]+)["']?\s*\n?/m, "");
  }

  return filtered;
}

/** Filter tree nodes whose path (or descendant paths) match a search string */
function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  return nodes
    .map((node) => {
      if (node.kind === "file") {
        return node.name.toLowerCase().includes(lower) || node.path.toLowerCase().includes(lower)
          ? node
          : null;
      }
      const filteredChildren = filterTree(node.children, query);
      return filteredChildren.length > 0
        ? { ...node, children: filteredChildren }
        : null;
    })
    .filter((n): n is FileTreeNode => n !== null);
}

/** Collect all ancestor dir paths for files that match a filter */
function collectMatchedParentDirs(nodes: FileTreeNode[], query: string): Set<string> {
  const dirs = new Set<string>();
  const lower = query.toLowerCase();

  function walk(node: FileTreeNode, ancestors: string[]) {
    if (node.kind === "file") {
      if (node.name.toLowerCase().includes(lower) || node.path.toLowerCase().includes(lower)) {
        for (const a of ancestors) dirs.add(a);
      }
    } else {
      for (const child of node.children) {
        walk(child, [...ancestors, node.path]);
      }
    }
  }

  for (const node of nodes) walk(node, []);
  return dirs;
}

/** Sort tree: checked files first, then unchecked */
function sortByChecked(nodes: FileTreeNode[], checkedFiles: Set<string>): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "dir") {
      return { ...node, children: sortByChecked(node.children, checkedFiles) };
    }
    return node;
  }).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
    if (a.kind === "file" && b.kind === "file") {
      const aChecked = checkedFiles.has(a.path);
      const bChecked = checkedFiles.has(b.path);
      if (aChecked !== bChecked) return aChecked ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

const TASKS_PAGE_SIZE = 10;

/**
 * Paginate children of `tasks/` directories: show up to `limit` entries,
 * but always include children that are checked or match the search query.
 * Returns the paginated tree and the total count of task children.
 */
function paginateTaskNodes(
  nodes: FileTreeNode[],
  limit: number,
  checkedFiles: Set<string>,
  searchQuery: string,
): { nodes: FileTreeNode[]; totalTaskChildren: number; visibleTaskChildren: number } {
  let totalTaskChildren = 0;
  let visibleTaskChildren = 0;

  const result = nodes.map((node) => {
    // Only paginate direct children of "tasks" directories
    if (node.kind === "dir" && node.name === "tasks") {
      totalTaskChildren = node.children.length;

      // Partition children: pinned (checked or search-matched) vs rest
      const pinned: FileTreeNode[] = [];
      const rest: FileTreeNode[] = [];
      const lower = searchQuery.toLowerCase();

      for (const child of node.children) {
        const childFiles = collectAllPaths([child], "file");
        const isChecked = [...childFiles].some((p) => checkedFiles.has(p));
        const isSearchMatch = searchQuery && (
          child.name.toLowerCase().includes(lower) ||
          child.path.toLowerCase().includes(lower) ||
          [...childFiles].some((p) => p.toLowerCase().includes(lower))
        );
        if (isChecked || isSearchMatch) {
          pinned.push(child);
        } else {
          rest.push(child);
        }
      }

      // Show pinned + up to `limit` from rest
      const remaining = Math.max(0, limit - pinned.length);
      const visible = [...pinned, ...rest.slice(0, remaining)];
      visibleTaskChildren = visible.length;

      return { ...node, children: visible };
    }
    return node;
  });

  return { nodes: result, totalTaskChildren, visibleTaskChildren };
}

function downloadZip(
  exported: CompanyPortabilityExportResult,
  selectedFiles: Set<string>,
  effectiveFiles: Record<string, CompanyPortabilityFileEntry>,
) {
  const filteredFiles: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [path] of Object.entries(exported.files)) {
    if (selectedFiles.has(path)) filteredFiles[path] = effectiveFiles[path] ?? exported.files[path];
  }
  const zipBytes = createZipArchive(filteredFiles, exported.rootPath);
  const zipBuffer = new ArrayBuffer(zipBytes.byteLength);
  new Uint8Array(zipBuffer).set(zipBytes);
  const blob = new Blob([zipBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${exported.rootPath}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Frontmatter card (export-specific: skill click support) ──────────

function FrontmatterCard({
  data,
  onSkillClick,
}: {
  data: FrontmatterData;
  onSkillClick?: (skill: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-accent/20 px-4 py-3 mb-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground whitespace-nowrap py-0.5">
              {FRONTMATTER_FIELD_LABELS[key] ?? key}
            </dt>
            <dd className="py-0.5">
              {Array.isArray(value) ? (
                <div className="flex flex-wrap gap-1.5">
                  {value.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn(
                        "inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs",
                        key === "skills" && onSkillClick && "cursor-pointer hover:bg-accent/50 hover:border-foreground/30 transition-colors",
                      )}
                      onClick={() => key === "skills" && onSkillClick?.(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : (
                <span>{value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── Client-side README generation ────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO", cto: "CTO", cmo: "CMO", cfo: "CFO", coo: "COO",
  vp: "VP", manager: "Manager", engineer: "Engineer", agent: "Agent",
};

/**
 * Regenerate README.md content based on the currently checked files.
 * Only counts/lists entities whose files are in the checked set.
 */
function generateReadmeFromSelection(
  manifest: CompanyPortabilityManifest,
  checkedFiles: Set<string>,
  companyName: string,
  companyDescription: string | null,
): string {
  const slugs = checkedSlugs(checkedFiles);

  const agents = manifest.agents.filter((a) => slugs.agents.has(a.slug));
  const projects = manifest.projects.filter((p) => slugs.projects.has(p.slug));
  const tasks = manifest.issues.filter((t) => slugs.tasks.has(t.slug));
  const skills = manifest.skills.filter((s) => {
    // Skill files live under skills/{key}/...
    return [...checkedFiles].some((f) => f.startsWith(`skills/${s.key}/`) || f.startsWith(`skills/`) && f.includes(`/${s.slug}/`));
  });

  const lines: string[] = [];
  lines.push(`# ${companyName}`);
  lines.push("");
  if (companyDescription) {
    lines.push(`> ${companyDescription}`);
    lines.push("");
  }
  // Org chart image (generated during export as images/org-chart.png)
  if (agents.length > 0) {
    lines.push("![Org Chart](images/org-chart.png)");
    lines.push("");
  }

  lines.push("## What's Inside");
  lines.push("");
  lines.push("This is an [Agent Company](https://paperclip.ing) package.");
  lines.push("");

  const counts: Array<[string, number]> = [];
  if (agents.length > 0) counts.push(["Agents", agents.length]);
  if (projects.length > 0) counts.push(["Projects", projects.length]);
  if (skills.length > 0) counts.push(["Skills", skills.length]);
  if (tasks.length > 0) counts.push(["Tasks", tasks.length]);

  if (counts.length > 0) {
    lines.push("| Content | Count |");
    lines.push("|---------|-------|");
    for (const [label, count] of counts) {
      lines.push(`| ${label} | ${count} |`);
    }
    lines.push("");
  }

  if (agents.length > 0) {
    lines.push("### Agents");
    lines.push("");
    lines.push("| Agent | Role | Reports To |");
    lines.push("|-------|------|------------|");
    for (const agent of agents) {
      const roleLabel = ROLE_LABELS[agent.role] ?? agent.role;
      const reportsTo = agent.reportsToSlug ?? "\u2014";
      lines.push(`| ${agent.name} | ${roleLabel} | ${reportsTo} |`);
    }
    lines.push("");
  }

  if (projects.length > 0) {
    lines.push("### Projects");
    lines.push("");
    for (const project of projects) {
      const desc = project.description ? ` \u2014 ${project.description}` : "";
      lines.push(`- **${project.name}**${desc}`);
    }
    lines.push("");
  }

  lines.push("## Getting Started");
  lines.push("");
  lines.push("```bash");
  lines.push("pnpm paperclipai company import this-github-url-or-folder");
  lines.push("```");
  lines.push("");
  lines.push("See [Paperclip](https://paperclip.ing) for more information.");
  lines.push("");
  lines.push("---");
  lines.push(`Exported from [Paperclip](https://paperclip.ing) on ${new Date().toISOString().split("T")[0]}`);
  lines.push("");

  return lines.join("\n");
}

// ── Preview pane ──────────────────────────────────────────────────────

function ExportPreviewPane({
  selectedFile,
  content,
  allFiles,
  onSkillClick,
}: {
  selectedFile: string | null;
  content: CompanyPortabilityFileEntry | null;
  allFiles: Record<string, CompanyPortabilityFileEntry>;
  onSkillClick?: (skill: string) => void;
}) {
  if (!selectedFile || content === null) {
    return (
      <EmptyState icon={Package} message="Select a file to preview its contents." />
    );
  }

  const textContent = getPortableFileText(content);
  const isMarkdown = selectedFile.endsWith(".md") && textContent !== null;
  const parsed = isMarkdown && textContent ? parseFrontmatter(textContent) : null;
  const imageSrc = isPortableImageFile(selectedFile, content) ? getPortableFileDataUrl(selectedFile, content) : null;

  // Resolve relative image paths within the export package (e.g. images/org-chart.png)
  const resolveImageSrc = isMarkdown
    ? (src: string) => {
        // Skip absolute URLs and data URIs
        if (/^(?:https?:|data:)/i.test(src)) return null;
        // Resolve relative to the directory of the current markdown file
        const dir = selectedFile.includes("/") ? selectedFile.slice(0, selectedFile.lastIndexOf("/") + 1) : "";
        const resolved = dir + src;
        const entry = allFiles[resolved] ?? allFiles[src];
        if (!entry) return null;
        return getPortableFileDataUrl(resolved in allFiles ? resolved : src, entry);
      }
    : undefined;

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-3">
        <div className="truncate font-mono text-sm">{selectedFile}</div>
      </div>
      <div className="min-h-[560px] px-5 py-5">
        {parsed ? (
          <>
            <FrontmatterCard data={parsed.data} onSkillClick={onSkillClick} />
            {parsed.body.trim() && <MarkdownBody resolveImageSrc={resolveImageSrc} softBreaks={false} linkIssueReferences={false}>{parsed.body}</MarkdownBody>}
          </>
        ) : isMarkdown ? (
          <MarkdownBody resolveImageSrc={resolveImageSrc} softBreaks={false} linkIssueReferences={false}>{textContent ?? ""}</MarkdownBody>
        ) : imageSrc ? (
          <div className="flex min-h-[520px] items-center justify-center rounded-lg border border-border bg-accent/10 p-6">
            <img src={imageSrc} alt={selectedFile} className="max-h-[480px] max-w-full object-contain" />
          </div>
        ) : textContent !== null ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{textContent}</code>
          </pre>
        ) : (
          <div className="rounded-lg border border-border bg-accent/10 px-4 py-3 text-sm text-muted-foreground">
            Binary asset preview is not available for this file type.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────

/** Extract the file path from the current URL pathname (after /company/export/files/) */
function filePathFromLocation(pathname: string): string | null {
  const marker = "/company/export/files/";
  const idx = pathname.indexOf(marker);
  if (idx === -1) return null;
  const filePath = decodeURIComponent(pathname.slice(idx + marker.length));
  return filePath || null;
}

/** Expand all ancestor directories for a given file path */
function expandAncestors(filePath: string): string[] {
  const parts = filePath.split("/").slice(0, -1);
  const dirs: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    dirs.push(current);
  }
  return dirs;
}

export function CompanyExport() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isFetched: isSessionFetched } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: agents = [], isFetched: areAgentsFetched } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects = [], isFetched: areProjectsFetched } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const [exportData, setExportData] = useState<CompanyPortabilityExportPreviewResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [treeSearch, setTreeSearch] = useState("");
  const [taskLimit, setTaskLimit] = useState(TASKS_PAGE_SIZE);
  const savedExpandedRef = useRef<Set<string> | null>(null);
  const initialFileFromUrl = useRef(filePathFromLocation(location.pathname));
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const visibleAgents = useMemo(
    () => agents.filter((agent: Agent) => agent.status !== "terminated"),
    [agents],
  );
  const visibleProjects = useMemo(
    () => projects.filter((project: Project) => !project.archivedAt),
    [projects],
  );
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { orderedProjects } = useProjectOrder({
    projects: visibleProjects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const sidebarOrder = useMemo(
    () => buildPortableSidebarOrder({
      agents: visibleAgents,
      orderedAgents,
      projects: visibleProjects,
      orderedProjects,
    }),
    [orderedAgents, orderedProjects, visibleAgents, visibleProjects],
  );
  const sidebarOrderKey = useMemo(
    () => JSON.stringify(sidebarOrder ?? null),
    [sidebarOrder],
  );

  // Navigate-aware file selection: updates state + URL without page reload.
  // `replace` = true skips history entry (used for initial load); false = pushes (used for clicks).
  const selectFile = useCallback(
    (filePath: string | null, replace = false) => {
      setSelectedFile(filePath);
      if (filePath) {
        navigate(`/company/export/files/${encodeURI(filePath)}`, { replace });
      } else {
        navigate("/company/export", { replace });
      }
    },
    [navigate],
  );

  // Sync selectedFile from URL on browser back/forward
  useEffect(() => {
    if (!exportData) return;
    const urlFile = filePathFromLocation(location.pathname);
    if (urlFile && urlFile in exportData.files && urlFile !== selectedFile) {
      setSelectedFile(urlFile);
      // Expand ancestors so the file is visible in the tree
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of expandAncestors(urlFile)) next.add(dir);
        return next;
      });
    } else if (!urlFile && selectedFile) {
      setSelectedFile(null);
    }
  }, [location.pathname, exportData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBreadcrumbs([
      { label: "Org Chart", href: "/org" },
      { label: "Export" },
    ]);
  }, [setBreadcrumbs]);

  const exportPreviewMutation = useMutation({
    mutationFn: () =>
      companiesApi.exportPreview(selectedCompanyId!, {
        include: { company: true, agents: true, projects: true, issues: true },
        sidebarOrder,
      }),
    onSuccess: (result) => {
      setExportData(result);
      setCheckedFiles((prev) =>
        buildInitialExportCheckedFiles(
          Object.keys(result.files),
          result.manifest.issues,
          prev,
        ),
      );
      // Expand top-level dirs (except tasks — collapsed by default)
      const tree = buildFileTree(result.files);
      const topDirs = new Set<string>();
      for (const node of tree) {
        if (node.kind === "dir" && node.name !== "tasks") topDirs.add(node.path);
      }

      // If URL contains a deep-linked file path, select it and expand ancestors
      const urlFile = initialFileFromUrl.current;
      if (urlFile && urlFile in result.files) {
        setSelectedFile(urlFile);
        const ancestors = expandAncestors(urlFile);
        setExpandedDirs(new Set([...topDirs, ...ancestors]));
      } else {
        // Default to README.md if present, otherwise fall back to first file
        const defaultFile = "README.md" in result.files
          ? "README.md"
          : Object.keys(result.files)[0];
        if (defaultFile) {
          selectFile(defaultFile, true);
        }
        setExpandedDirs(topDirs);
      }
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Export failed",
        body: err instanceof Error ? err.message : "Failed to load export data.",
      });
    },
  });

  const downloadMutation = useMutation({
    mutationFn: () =>
      companiesApi.exportBundle(selectedCompanyId!, {
        include: { company: true, agents: true, projects: true, issues: true },
        selectedFiles: Array.from(checkedFiles).sort(),
        sidebarOrder,
      }),
    onSuccess: (result) => {
      const resultCheckedFiles = new Set(Object.keys(result.files));
      downloadZip(result, resultCheckedFiles, result.files);
      pushToast({
        tone: "success",
        title: "Export downloaded",
        body: `${resultCheckedFiles.size} file${resultCheckedFiles.size === 1 ? "" : "s"} exported as ${result.rootPath}.zip`,
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Export failed",
        body: err instanceof Error ? err.message : "Failed to build export package.",
      });
    },
  });

  useEffect(() => {
    if (!selectedCompanyId || exportPreviewMutation.isPending) return;
    if (!isSessionFetched || !areAgentsFetched || !areProjectsFetched) return;
    setExportData(null);
    exportPreviewMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId, isSessionFetched, areAgentsFetched, areProjectsFetched, sidebarOrderKey]);

  const tree = useMemo(
    () => (exportData ? buildFileTree(exportData.files) : []),
    [exportData],
  );

  const { displayTree, totalTaskChildren, visibleTaskChildren } = useMemo(() => {
    let result = tree;
    if (treeSearch) result = filterTree(result, treeSearch);
    result = sortByChecked(result, checkedFiles);
    const paginated = paginateTaskNodes(result, taskLimit, checkedFiles, treeSearch);
    return {
      displayTree: paginated.nodes,
      totalTaskChildren: paginated.totalTaskChildren,
      visibleTaskChildren: paginated.visibleTaskChildren,
    };
  }, [tree, treeSearch, checkedFiles, taskLimit]);

  // Recompute .paperclip.yaml and README.md content whenever checked files
  // change so the preview & download always reflect the current selection.
  const effectiveFiles = useMemo(() => {
    if (!exportData) return {} as Record<string, CompanyPortabilityFileEntry>;
    const filtered = { ...exportData.files };

    // Filter .paperclip.yaml
    const yamlPath = exportData.paperclipExtensionPath;
    if (yamlPath && typeof exportData.files[yamlPath] === "string") {
      filtered[yamlPath] = filterPaperclipYaml(exportData.files[yamlPath], checkedFiles);
    }

    // Regenerate README.md based on checked selection
    if (typeof exportData.files["README.md"] === "string") {
      const companyName = exportData.manifest.company?.name ?? selectedCompany?.name ?? "Company";
      const companyDescription = exportData.manifest.company?.description ?? null;
      filtered["README.md"] = generateReadmeFromSelection(
        exportData.manifest,
        checkedFiles,
        companyName,
        companyDescription,
      );
    }

    return filtered;
  }, [exportData, checkedFiles, selectedCompany?.name]);

  const totalFiles = useMemo(() => countFiles(tree), [tree]);
  const selectedCount = checkedFiles.size;

  // Filter out terminated agent messages — they don't need to be shown
  const warnings = useMemo(() => {
    if (!exportData) return [] as string[];
    return exportData.warnings.filter((w) => !/terminated agent/i.test(w));
  }, [exportData]);

  function handleToggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleToggleCheck(path: string, kind: "file" | "dir") {
    if (!exportData) return;
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (kind === "file") {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else {
        // Find all child file paths under this dir
        const dirTree = buildFileTree(exportData.files);
        const findNode = (nodes: FileTreeNode[], target: string): FileTreeNode | null => {
          for (const n of nodes) {
            if (n.path === target) return n;
            const found = findNode(n.children, target);
            if (found) return found;
          }
          return null;
        };
        const dirNode = findNode(dirTree, path);
        if (dirNode) {
          const childFiles = collectAllPaths(dirNode.children, "file");
          // Add the dir's own file children
          for (const child of dirNode.children) {
            if (child.kind === "file") childFiles.add(child.path);
          }
          const allChecked = [...childFiles].every((p) => next.has(p));
          for (const f of childFiles) {
            if (allChecked) next.delete(f);
            else next.add(f);
          }
        }
      }
      return next;
    });
  }

  function handleSearchChange(query: string) {
    const wasSearching = treeSearch.length > 0;
    const isSearching = query.length > 0;

    if (isSearching && !wasSearching) {
      // Save current expansion state before search
      savedExpandedRef.current = new Set(expandedDirs);
    }

    setTreeSearch(query);

    if (isSearching) {
      // Expand all parent dirs of matched files
      const matchedParents = collectMatchedParentDirs(tree, query);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        for (const d of matchedParents) next.add(d);
        return next;
      });
    } else if (wasSearching) {
      // Restore pre-search expansion state
      if (savedExpandedRef.current) {
        setExpandedDirs(savedExpandedRef.current);
        savedExpandedRef.current = null;
      }
    }
  }

  function handleSkillClick(skillKey: string) {
    if (!exportData) return;
    const manifestSkill = exportData.manifest.skills.find(
      (skill) => skill.key === skillKey || skill.slug === skillKey,
    );
    const skillPath = manifestSkill?.path ?? `skills/${skillKey}/SKILL.md`;
    if (!(skillPath in exportData.files)) return;
    selectFile(skillPath);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.add("skills");
      const parts = skillPath.split("/").slice(0, -1);
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        next.add(current);
      }
      return next;
    });
  }

  function handleDownload() {
    if (!exportData || checkedFiles.size === 0 || downloadMutation.isPending) return;
    downloadMutation.mutate();
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select a company to export." />;
  }

  if (exportPreviewMutation.isPending && !exportData) {
    return <PageSkeleton variant="detail" />;
  }

  if (!exportData) {
    return <EmptyState icon={Package} message="Loading export data..." />;
  }

  const previewContent = selectedFile
    ? (() => {
        return effectiveFiles[selectedFile] ?? null;
      })()
    : null;

  return (
    <div>
      {/* Sticky top action bar */}
      <div className="sticky top-0 z-10 border-b border-border bg-background px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium">
              {selectedCompany?.name ?? "Company"} export
            </span>
            <span className="text-muted-foreground">
              {selectedCount} / {totalFiles} file{totalFiles === 1 ? "" : "s"} selected
            </span>
            {warnings.length > 0 && (
              <span className="text-amber-500">
                {warnings.length} warning{warnings.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={selectedCount === 0 || downloadMutation.isPending}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {downloadMutation.isPending
              ? "Building export..."
              : `Export ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mx-5 mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          {warnings.map((w) => (
            <div key={w} className="text-xs text-amber-500">{w}</div>
          ))}
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="flex flex-col border-r border-border overflow-hidden">
          <div className="border-b border-border px-4 py-3 shrink-0">
            <h2 className="text-base font-semibold">Package files</h2>
          </div>
          <div className="border-b border-border px-3 py-2 shrink-0">
            <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={treeSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search files..."
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                data-page-search-target="true"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <FileTree
              nodes={displayTree}
              selectedFile={selectedFile}
              expandedDirs={expandedDirs}
              checkedFiles={checkedFiles}
              onToggleDir={handleToggleDir}
              onSelectFile={selectFile}
              onToggleCheck={handleToggleCheck}
              wrapLabels={false}
            />
            {totalTaskChildren > visibleTaskChildren && !treeSearch && (
              <div className="px-4 py-2">
                <button
                  type="button"
                  onClick={() => setTaskLimit((prev) => prev + TASKS_PAGE_SIZE)}
                  className="w-full rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/30 hover:text-foreground transition-colors"
                >
                  Show more issues ({visibleTaskChildren} of {totalTaskChildren})
                </button>
              </div>
            )}
          </div>
        </aside>
        <div className="min-w-0 overflow-y-auto pl-6">
          <ExportPreviewPane selectedFile={selectedFile} content={previewContent} allFiles={effectiveFiles} onSkillClick={handleSkillClick} />
        </div>
      </div>
    </div>
  );
}
