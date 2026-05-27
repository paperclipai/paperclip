import { useEffect, useMemo, useState, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillSourceBadge,
  CompanySkillUpdateStatus,
} from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
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
import { useLocalizedCopy } from "../i18n/ui-copy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Link2,
  ExternalLink,
  Paperclip,
  Pencil,
  Plus,
  Copy,
  RefreshCw,
  Save,
  Search,
  Trash2,
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

type LocalizedCopyFn = ReturnType<typeof useLocalizedCopy>;

function formatProjectScanSummary(result: CompanySkillProjectScanResult, copy: LocalizedCopyFn) {
  const parts = [
    copy("skills.scan.found", "{{count}} found", "{{count}}개 발견", { count: result.discovered }),
    copy("skills.scan.imported", "{{count}} imported", "{{count}}개 가져옴", { count: result.imported.length }),
    copy("skills.scan.updated", "{{count}} updated", "{{count}}개 업데이트", { count: result.updated.length }),
  ];
  if (result.conflicts.length > 0) {
    parts.push(copy("skills.scan.conflicts", "{{count}} conflicts", "충돌 {{count}}개", { count: result.conflicts.length }));
  }
  if (result.skipped.length > 0) {
    parts.push(copy("skills.scan.skipped", "{{count}} skipped", "{{count}}개 건너뜀", { count: result.skipped.length }));
  }
  return copy(
    "skills.scan.summary",
    "{{summary}} across {{count}} workspace.",
    "작업공간 {{count}}개에서 {{summary}}.",
    { summary: parts.join(", "), count: result.scannedWorkspaces },
  );
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

function parentDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return parents;
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
  const copy = useLocalizedCopy();

  return (
    <div className="border-b border-border px-4 py-4">
      <div className="space-y-3">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={copy("skills.new.name", "Skill name", "스킬 이름")}
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
          placeholder={copy("skills.new.description", "Short description", "짧은 설명")}
          className="min-h-20 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            {copy("common.cancel", "Cancel", "취소")}
          </Button>
          <Button
            size="sm"
            onClick={() => onCreate({ name, slug: slug || null, description: description || null })}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending
              ? copy("skills.new.creating", "Creating...", "만드는 중...")
              : copy("skills.new.create", "Create skill", "스킬 만들기")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkillTree({
  nodes,
  skillId,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  depth = 0,
}: {
  nodes: SkillTreeNode[];
  skillId: string;
  selectedPath: string;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
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
            to={skillRoute(skillId, node.path)}
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
  expandedSkillId,
  expandedDirs,
  selectedPaths,
  onToggleSkill,
  onToggleDir,
  onSelectSkill,
  onSelectPath,
}: {
  skills: CompanySkillListItem[];
  selectedSkillId: string | null;
  skillFilter: string;
  expandedSkillId: string | null;
  expandedDirs: Record<string, Set<string>>;
  selectedPaths: Record<string, string>;
  onToggleSkill: (skillId: string) => void;
  onToggleDir: (skillId: string, path: string) => void;
  onSelectSkill: (skillId: string) => void;
  onSelectPath: (skillId: string, path: string) => void;
}) {
  const copy = useLocalizedCopy();
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    return haystack.includes(skillFilter.toLowerCase());
  });

  if (filteredSkills.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {copy("skills.list.noMatches", "No skills match this filter.", "이 필터와 일치하는 스킬이 없습니다.")}
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
                aria-label={expanded
                  ? copy("skills.list.collapse", "Collapse {{name}}", "{{name}} 접기", { name: skill.name })
                  : copy("skills.list.expand", "Expand {{name}}", "{{name}} 펼치기", { name: skill.name })}
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
}) {
  const copy = useLocalizedCopy();
  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return (
      <EmptyState
        icon={Boxes}
        message={copy("skills.detail.empty", "Select a skill to inspect its files.", "파일을 확인할 스킬을 선택하세요.")}
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
  const editableReason = detail.editableReason?.includes("Bundled Paperclip skills are read-only")
    ? copy("skills.detail.bundledReadOnly", "Bundled Paperclip skills are read-only.", "기본 제공 Paperclip 스킬은 읽기 전용입니다.")
    : detail.editableReason;
  const removeBlocked = usedBy.length > 0;
  const removeDisabledReason = removeBlocked
    ? copy("skills.detail.removeBlocked", "Detach this skill from all agents before removing it.", "삭제하기 전에 모든 직원에서 이 스킬 연결을 해제하세요.")
    : null;
  const applicationStatus = detail.editable
    ? copy("skills.detail.applyEditable", "Editable company skill", "회사 스킬로 편집/적용 가능")
    : copy("skills.detail.applyReadOnly", "Read-only source skill", "읽기 전용 출처 스킬");
  const connectionStatus = usedBy.length === 0
    ? copy("skills.detail.connectionNone", "Not attached to any agent", "연결된 직원 없음")
    : copy(
        "skills.detail.connectionCount",
        usedBy.length === 1 ? "Attached to {{count}} agent" : "Attached to {{count}} agents",
        "직원 {{count}}명에 연결됨",
        { count: usedBy.length },
      );

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
              {deletePending ? copy("skills.remove.removing", "Removing...", "삭제 중...") : copy("common.remove", "Remove", "삭제")}
            </Button>
            {detail.editable ? (
              <button
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setEditMode(!editMode)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode
                  ? copy("skills.detail.stopEditing", "Stop editing", "편집 중지")
                  : copy("common.edit", "Edit", "편집")}
              </button>
            ) : (
              <div className="text-sm text-muted-foreground">{editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy("skills.detail.source", "Source", "출처")}</span>
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
                      copiedLabel={copy("skills.detail.copiedPath", "Copied path", "경로 복사됨")}
                      ariaLabel={copy("skills.detail.copySourcePath", "Copy source path", "출처 경로 복사")}
                      title={copy("skills.detail.copySourcePath", "Copy source path", "출처 경로 복사")}
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
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy("skills.detail.pin", "Pin", "고정")}</span>
                <span className="font-mono text-xs">{currentPin ?? copy("skills.detail.untracked", "untracked", "추적 안 함")}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">
                    {copy("skills.detail.tracking", "tracking {{ref}}", "{{ref}} 추적 중", { ref: updateStatus.trackingRef })}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  {copy("skills.detail.checkUpdates", "Check for updates", "업데이트 확인")}
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    {copy("skills.detail.installUpdate", "Install update", "업데이트 설치")}{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">{copy("skills.detail.upToDate", "Up to date", "최신 상태")}</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy("skills.detail.key", "Key", "키")}</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy("skills.detail.mode", "Mode", "모드")}</span>
              <span>{detail.editable ? copy("skills.detail.editable", "Editable", "편집 가능") : copy("skills.detail.readOnly", "Read only", "읽기 전용")}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy("skills.detail.usedBy", "Used by", "사용 중인 직원")}</span>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">{copy("skills.detail.noAgents", "No agents attached", "연결된 직원 없음")}</span>
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

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="flex items-start gap-2 border border-border/70 bg-background/70 p-3">
              <Eye className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs font-medium">{copy("skills.detail.readState", "Read", "읽기")}</div>
                <div className="mt-1 text-xs text-muted-foreground">{copy("skills.detail.readAvailable", "SKILL.md and files can be inspected here.", "SKILL.md와 파일 내용을 여기서 확인할 수 있습니다.")}</div>
              </div>
            </div>
            <div className="flex items-start gap-2 border border-border/70 bg-background/70 p-3">
              <Boxes className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs font-medium">{copy("skills.detail.applyState", "Apply", "적용")}</div>
                <div className="mt-1 text-xs text-muted-foreground">{applicationStatus}</div>
              </div>
            </div>
            <div className="flex items-start gap-2 border border-border/70 bg-background/70 p-3">
              <Link2 className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs font-medium">{copy("skills.detail.connectionState", "Connection", "연결")}</div>
                <div className="mt-1 text-xs text-muted-foreground">{connectionStatus}</div>
              </div>
            </div>
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
                    {copy("skills.detail.view", "View", "보기")}
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    {copy("skills.detail.code", "Code", "코드")}
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  {copy("common.cancel", "Cancel", "취소")}
                </Button>
                <Button size="sm" onClick={onSave} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? copy("common.savingDots", "Saving...", "저장 중...") : copy("common.save", "Save", "저장")}
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
          <div className="text-sm text-muted-foreground">{copy("skills.detail.selectFile", "Select a file to inspect.", "확인할 파일을 선택하세요.")}</div>
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
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const copy = useLocalizedCopy();
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
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillId = parsedRoute.skillId;
  const selectedPath = parsedRoute.filePath;

  useEffect(() => {
    setBreadcrumbs([
      { label: copy("skills.breadcrumb", "Skills", "스킬"), href: "/skills" },
      ...(routeSkillId ? [{ label: copy("skills.breadcrumb.detail", "Detail", "상세") }] : []),
    ]);
  }, [copy, routeSkillId, setBreadcrumbs]);

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
    if (routeSkillId || !selectedSkillId) return;
    navigate(skillRoute(selectedSkillId), { replace: true });
  }, [navigate, routeSkillId, selectedSkillId]);

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
        title: copy("skills.toast.imported", "Skills imported", "스킬 가져오기 완료"),
        body: copy(
          "skills.toast.importedBody",
          result.imported.length === 1 ? "{{count}} skill added." : "{{count}} skills added.",
          "스킬 {{count}}개가 추가되었습니다.",
          { count: result.imported.length },
        ),
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: copy("skills.toast.importWarnings", "Import warnings", "가져오기 경고"), body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: copy("skills.toast.importFailed", "Skill import failed", "스킬 가져오기 실패"),
        body: error instanceof Error ? error.message : copy("skills.toast.importFailedBody", "Failed to import skill source.", "스킬 출처를 가져오지 못했습니다."),
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
        title: copy("skills.toast.created", "Skill created", "스킬 생성됨"),
        body: copy(
          "skills.toast.createdBody",
          "{{name}} is now editable in the Paperclip workspace.",
          "{{name}} 스킬을 Paperclip 작업공간에서 편집할 수 있습니다.",
          { name: skill.name },
        ),
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: copy("skills.toast.createFailed", "Skill creation failed", "스킬 생성 실패"),
        body: error instanceof Error ? error.message : copy("skills.toast.createFailedBody", "Failed to create skill.", "스킬을 만들지 못했습니다."),
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onMutate: () => {
      setScanStatusMessage(copy("skills.scan.scanning", "Scanning project workspaces for skills...", "프로젝트 작업공간에서 스킬을 찾는 중..."));
    },
    onSuccess: async (result) => {
      setScanStatusMessage(copy("skills.scan.refreshing", "Refreshing skills list...", "스킬 목록 새로고침 중..."));
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      const summary = formatProjectScanSummary(result, copy);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: copy("skills.toast.scanComplete", "Project skill scan complete", "프로젝트 스킬 스캔 완료"),
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: copy("skills.toast.conflicts", "Skill conflicts found", "스킬 충돌 발견"),
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: copy("skills.toast.scanWarnings", "Scan warnings", "스캔 경고"),
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: copy("skills.toast.scanFailed", "Project skill scan failed", "프로젝트 스킬 스캔 실패"),
        body: error instanceof Error ? error.message : copy("skills.toast.scanFailedBody", "Failed to scan project workspaces.", "프로젝트 작업공간에서 스킬을 스캔하지 못했습니다."),
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
        title: copy("skills.toast.saved", "Skill saved", "스킬 저장됨"),
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: copy("skills.toast.saveFailed", "Save failed", "저장 실패"),
        body: error instanceof Error ? error.message : copy("skills.toast.saveFailedBody", "Failed to save skill file.", "스킬 파일을 저장하지 못했습니다."),
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
        title: copy("skills.toast.updated", "Skill updated", "스킬 업데이트됨"),
        body: skill.sourceRef
          ? copy("skills.toast.pinnedTo", "Pinned to {{ref}}", "{{ref}}에 고정됨", { ref: shortRef(skill.sourceRef) })
          : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: copy("skills.toast.updateFailed", "Update failed", "업데이트 실패"),
        body: error instanceof Error ? error.message : copy("skills.toast.updateFailedBody", "Failed to install skill update.", "스킬 업데이트를 설치하지 못했습니다."),
      });
    },
  });

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
        title: copy("skills.toast.removed", "Skill removed", "스킬 삭제됨"),
        body: copy(
          "skills.toast.removedBody",
          "{{name}} was removed from the company skill library.",
          "{{name}} 스킬이 회사 스킬 라이브러리에서 삭제되었습니다.",
          { name: skill.name },
        ),
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: copy("skills.toast.removeFailed", "Remove failed", "삭제 실패"),
        body: error instanceof Error ? error.message : copy("skills.toast.removeFailedBody", "Failed to remove skill.", "스킬을 삭제하지 못했습니다."),
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message={copy("skills.noCompany", "Select a company to manage skills.", "스킬을 관리하려면 회사를 선택하세요.")} />;
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
            <DialogTitle>{copy("skills.remove.title", "Remove skill", "스킬 삭제")}</DialogTitle>
            <DialogDescription>
              {copy(
                "skills.remove.description",
                "Remove this skill from the company library. If any agents still use it, removal will be blocked until it is detached.",
                "회사 라이브러리에서 이 스킬을 삭제합니다. 아직 사용하는 직원이 있으면 연결 해제 전까지 삭제가 차단됩니다.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {deleteTargetDetail
                ? copy("skills.remove.confirmNamed", "You are about to remove {{name}}.", "{{name}} 스킬을 삭제하려고 합니다.", { name: deleteTargetDetail.name })
                : copy("skills.remove.confirm", "You are about to remove this skill.", "이 스킬을 삭제하려고 합니다.")}
            </p>
            {deleteTargetDetail?.usedByAgents?.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                {copy(
                  "skills.remove.currentlyUsedBy",
                  "Currently used by {{agents}}.",
                  "현재 {{agents}} 직원이 사용 중입니다.",
                  { agents: deleteTargetDetail.usedByAgents.map((agent) => agent.name).join(", ") },
                )}
              </div>
            ) : null}
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                {copy("skills.remove.detachFirst", "Detach this skill from all agents to enable removal.", "삭제하려면 먼저 모든 직원에서 이 스킬 연결을 해제하세요.")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <Button variant="ghost" onClick={() => closeDeleteDialog(false)}>
                {copy("common.close", "Close", "닫기")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => closeDeleteDialog(false)} disabled={deleteSkill.isPending}>
                  {copy("common.cancel", "Cancel", "취소")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteSkill.mutate()}
                  disabled={deleteSkill.isPending || !deleteTargetSkillId}
                >
                  {deleteSkill.isPending
                    ? copy("skills.remove.removing", "Removing...", "삭제 중...")
                    : copy("skills.remove.action", "Remove skill", "스킬 삭제")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{copy("skills.addSource.title", "Add a skill source", "스킬 출처 추가")}</DialogTitle>
            <DialogDescription>
              {copy(
                "skills.addSource.description",
                "Paste a local path, GitHub URL, or `skills.sh` command into the field first.",
                "먼저 로컬 경로, GitHub URL 또는 `skills.sh` 명령을 입력란에 붙여넣으세요.",
              )}
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
                <span className="block font-medium">{copy("skills.addSource.browseSkillsSh", "Browse skills.sh", "skills.sh 둘러보기")}</span>
                <span className="mt-1 block text-muted-foreground">
                  {copy("skills.addSource.browseHelp", "Find install commands and paste one here.", "설치 명령을 찾아 여기에 붙여넣으세요.")}
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
                <span className="block font-medium">{copy("skills.addSource.searchGithub", "Search GitHub", "GitHub 검색")}</span>
                <span className="mt-1 block text-muted-foreground">
                  {copy(
                    "skills.addSource.githubHelp",
                    "Look for repositories with `SKILL.md`, then paste the repo URL here.",
                    "`SKILL.md`가 있는 저장소를 찾은 뒤 저장소 URL을 여기에 붙여넣으세요.",
                  )}
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="border-r border-border">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h1 className="text-base font-semibold">{copy("skills.title", "Skills", "스킬")}</h1>
                <p className="text-xs text-muted-foreground">
                  {copy("skills.available", "{{count}} available", "{{count}}개 사용 가능", { count: skillsQuery.data?.length ?? 0 })}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => scanProjects.mutate()}
                  disabled={scanProjects.isPending}
                  title={copy("skills.scan.action", "Scan project workspaces for skills", "프로젝트 작업공간에서 스킬 찾기")}
                  aria-label={copy("skills.scan.action", "Scan project workspaces for skills", "프로젝트 작업공간에서 스킬 찾기")}
                >
                  <RefreshCw className={cn("h-4 w-4", scanProjects.isPending && "animate-spin")} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCreateOpen((value) => !value)}
                  aria-label={copy("skills.new.open", "Create skill", "스킬 만들기")}
                  title={copy("skills.new.open", "Create skill", "스킬 만들기")}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
                placeholder={copy("skills.filter.placeholder", "Filter skills", "스킬 필터")}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
              <input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={copy(
                  "skills.source.placeholder",
                  "Paste path, GitHub URL, or skills.sh command",
                  "경로, GitHub URL 또는 skills.sh 명령 붙여넣기",
                )}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAddSkillSource}
                disabled={importSkill.isPending}
              >
                {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : copy("common.add", "Add", "추가")}
              </Button>
            </div>
            {scanStatusMessage && (
              <p className="mt-3 text-xs text-muted-foreground">
                {scanStatusMessage}
              </p>
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
          ) : (
            <SkillList
              skills={skillsQuery.data ?? []}
              selectedSkillId={selectedSkillId}
              skillFilter={skillFilter}
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
          />
        </div>
      </div>
    </>
  );
}
