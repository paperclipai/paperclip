import { useCallback, useEffect, useMemo, useRef, useState, type SVGProps } from "react";
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
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
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
  Download,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Layers,
  Link2,
  Loader2,
  ExternalLink,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Shield,
  Star,
  Sparkles,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

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

/* ── agentskill.sh inline review ─────────────────────────────────── */

function AgentSkillReview({
  slug,
  onSubmitted,
}: {
  slug: string;
  onSubmitted?: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
    if (rating === 0) return;
    setSubmitting(true);
    try {
      await fetch(`https://agentskill.sh/api/skills/${encodeURIComponent(slug)}/agent-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          score: rating,
          comment: comment.trim() || undefined,
          platform: "paperclip",
          agentName: "Paperclip",
          sessionId: `paperclip-${slug}-${Date.now()}`,
        }),
      });
      setSubmitted(true);
      onSubmitted?.();
    } catch {
      // silent fail
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="text-green-500">Thanks for your review!</span>
        <span className="flex items-center gap-0.5">
          {Array.from({ length: 5 }, (_, i) => (
            <Star
              key={i}
              className={cn("h-3 w-3", i < rating ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30")}
            />
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">Rate:</span>
        {Array.from({ length: 5 }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setRating(i + 1)}
            onMouseEnter={() => setHover(i + 1)}
            onMouseLeave={() => setHover(0)}
            className="p-0"
          >
            <Star
              className={cn(
                "h-4 w-4 transition-colors",
                i < (hover || rating)
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-muted-foreground/30 hover:text-yellow-400/50",
              )}
            />
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment"
            className="w-40 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={submitting}
            onClick={handleSubmit}
            className="h-6 px-2 text-xs"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
            <span className="ml-1">Submit</span>
          </Button>
        </>
      )}
    </div>
  );
}

/* ── agentskill.sh in-app browser ────────────────────────────────── */

type AgentSkillResult = {
  slug: string;
  name: string;
  owner: string;
  description: string;
  category: string;
  avatarUrl?: string;
  platforms: string[];
  installCount: number;
  githubStars: number;
  securityScore: number;
  contentQualityScore: number;
  updatedAt: string;
};

type AgentSkillSearchResponse = {
  data: AgentSkillResult[];
  total: number;
  hasMore: boolean;
  page: number;
};

type AgentSkillsetSkillDetail = {
  slug: string;
  name: string;
  description: string;
  securityScore: number;
  qualityReview?: { score: number };
};

type AgentSkillset = {
  slug: string;
  name: string;
  description: string;
  skills: string[];
  skillDetails: AgentSkillsetSkillDetail[];
  installCount: number;
  avgQualityScore: number;
  avgSecurityScore: number;
  author: { name: string; username: string };
};

const AGENTSKILL_API = "https://agentskill.sh/api/skills";
const AGENTSKILL_SKILLSETS_API = "https://agentskill.sh/api/skillsets";
const AGENTSKILL_SECTIONS = [
  { value: "top", label: "Top" },
  { value: "trending", label: "Trending" },
  { value: "hot", label: "Hot" },
  { value: "latest", label: "Latest" },
];
type AgentSkillCategory = { value: string; label: string };
const AGENTSKILL_CATEGORIES_API = "https://agentskill.sh/api/skills/categories";

function scoreColor(score: number) {
  if (score >= 80) return "text-green-500";
  if (score >= 50) return "text-yellow-500";
  return "text-red-400";
}

function scoreBadgeClass(score: number) {
  if (score >= 80) return "border-green-500/30 bg-green-500/10 text-green-500";
  if (score >= 50) return "border-yellow-500/30 bg-yellow-500/10 text-yellow-500";
  return "border-red-400/30 bg-red-400/10 text-red-400";
}

const SKILLS_PAGE_SIZE = 20;

function AgentSkillBrowser({
  onInstall,
  installing,
}: {
  onInstall: (slug: string) => void;
  installing: string | null;
}) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState("top");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<AgentSkillCategory[]>([]);
  const [results, setResults] = useState<AgentSkillResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(async (q: string, cat: string, sec: string, pg = 1) => {
    if (pg === 1) setLoading(true);
    else setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: String(SKILLS_PAGE_SIZE),
        page: String(pg),
        section: sec,
      });
      if (q) params.set("q", q);
      if (cat) params.set("category", cat);
      const res = await fetch(`${AGENTSKILL_API}?${params}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("API error");
      const data = (await res.json()) as AgentSkillSearchResponse;
      if (pg === 1) {
        setResults(data.data);
      } else {
        setResults((prev) => [...prev, ...data.data]);
      }
      setHasMore(data.hasMore && data.data.length > 0);
      setPage(pg);
    } catch {
      if (pg === 1) setResults([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!loaded) doSearch("", "", "top");
    fetch(AGENTSKILL_CATEGORIES_API, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((d: { data: Array<{ slug: string; name: string; count: number }> }) => {
        setCategories(
          d.data
            .filter((c) => c.count > 0)
            .sort((a, b) => b.count - a.count)
            .map((c) => ({ value: c.slug, label: c.name })),
        );
      })
      .catch(() => {});
  }, [loaded, doSearch]);

  useEffect(() => {
    setResults([]);
    setHasMore(false);
    setPage(1);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query, category, section, 1), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, category, section, doSearch]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading && !loadingMore) {
          doSearch(query, category, section, page + 1);
        }
      },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, page, query, category, section, doSearch]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5 text-xs">
          {AGENTSKILL_SECTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSection(s.value)}
              className={cn(
                "rounded px-2 py-1 transition-colors",
                section === s.value
                  ? "bg-foreground text-background font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      <div ref={scrollRef} className="max-h-[360px] overflow-y-auto rounded-md border border-border">
        {loading && !results.length ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading skills...
          </div>
        ) : results.length === 0 && loaded ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No skills found. Try a different search.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {results.map((skill) => (
              <div
                key={skill.slug}
                className="flex items-start gap-3 px-3 py-3 transition-colors hover:bg-accent/30"
              >
                {skill.avatarUrl && (
                  <img
                    src={skill.avatarUrl}
                    alt={skill.owner}
                    className="mt-0.5 h-5 w-5 shrink-0 rounded"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://agentskill.sh/${skill.slug}?ref=paperclip`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {skill.name}
                    </a>
                    <span className="shrink-0 text-xs text-muted-foreground">{skill.owner}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </p>
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className={cn("flex items-center gap-1", scoreColor(skill.contentQualityScore))}>
                      <Sparkles className="h-3 w-3" />
                      Quality {skill.contentQualityScore}
                    </span>
                    <span className={cn("flex items-center gap-1", scoreColor(skill.securityScore))}>
                      <Shield className="h-3 w-3" />
                      Security {skill.securityScore}
                    </span>
                    {skill.githubStars > 0 && (
                      <span className="flex items-center gap-1" title="GitHub stars">
                        <Star className="h-3 w-3" />
                        {skill.githubStars > 999
                          ? `${(skill.githubStars / 1000).toFixed(1)}k`
                          : skill.githubStars}
                      </span>
                    )}
                    <Badge variant="outline" className="h-4 text-[10px] px-1.5">
                      {skill.category}
                    </Badge>
                  </div>
                  {skill.securityScore < 50 && (
                    <p className="mt-1 text-[11px] text-red-400">
                      Low security score. This skill may contain unsafe tool calls or executable code. Review before installing.
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={skill.securityScore < 50 ? "destructive" : "outline"}
                  className="shrink-0 mt-1"
                  disabled={installing === skill.slug}
                  onClick={() => {
                    if (skill.securityScore < 50) {
                      if (!window.confirm(`Security score is ${skill.securityScore}/100. Install anyway?`)) return;
                    }
                    onInstall(skill.slug);
                  }}
                >
                  {installing === skill.slug ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  <span className="ml-1">Install</span>
                </Button>
              </div>
            ))}
            {hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-3 text-muted-foreground">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Powered by agentskill.sh</span>
        <a
          href="https://agentskill.sh?ref=paperclip"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-foreground/60 hover:text-foreground transition-colors"
        >
          Browse all <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function AgentSkillsetBrowser({
  onInstallSkillset,
  installingSkillset,
}: {
  onInstallSkillset: (skillset: AgentSkillset) => void;
  installingSkillset: string | null;
}) {
  const [skillsets, setSkillsets] = useState<AgentSkillset[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(AGENTSKILL_SKILLSETS_API, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error("API error");
        const data = await res.json() as { data: AgentSkillset[] };
        setSkillsets(data.data ?? []);
      } catch {
        setSkillsets([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Skillsets are curated bundles of skills. Install all skills in a set with one click.
      </p>

      <div className="max-h-[360px] overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading skillsets...
          </div>
        ) : skillsets.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No skillsets available.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {skillsets.map((ss) => (
              <div key={ss.slug} className="px-3 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-left"
                      onClick={() => setExpanded(expanded === ss.slug ? null : ss.slug)}
                    >
                      {expanded === ss.slug
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      }
                      <span className="text-sm font-medium">{ss.name}</span>
                      <Badge variant="outline" className="h-4 text-[10px] px-1.5">
                        {ss.skills.length} skills
                      </Badge>
                    </button>
                    <p className="mt-0.5 ml-5 text-xs text-muted-foreground line-clamp-1">
                      {ss.description}
                    </p>
                    <div className="mt-1 ml-5 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className={cn("flex items-center gap-1", scoreColor(ss.avgQualityScore))}>
                        <Sparkles className="h-3 w-3" />
                        Quality {ss.avgQualityScore}
                      </span>
                      <span className={cn("flex items-center gap-1", scoreColor(ss.avgSecurityScore))}>
                        <Shield className="h-3 w-3" />
                        Security {ss.avgSecurityScore}
                      </span>
                      <span className="flex items-center gap-1" title="Total installs">
                        <Download className="h-3 w-3" />
                        {ss.installCount} installs
                      </span>
                      <span>by {ss.author.name || ss.author.username}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 mt-1"
                    disabled={installingSkillset === ss.slug}
                    onClick={() => onInstallSkillset(ss)}
                  >
                    {installingSkillset === ss.slug ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span className="ml-1">Install all</span>
                  </Button>
                </div>
                {expanded === ss.slug && ss.skillDetails.length > 0 && (
                  <div className="mt-2 ml-5 grid grid-cols-1 gap-1.5 rounded-md border border-border/50 bg-accent/10 p-2 max-h-[200px] overflow-y-auto">
                    {ss.skillDetails.map((skill) => (
                      <a
                        key={skill.slug}
                        href={`https://agentskill.sh/${skill.slug}?ref=paperclip`}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex items-center gap-2 rounded px-2 py-1.5 text-xs no-underline transition-colors hover:bg-accent/40"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-foreground/90 group-hover:underline">{skill.name}</span>
                          <p className="mt-0.5 truncate text-muted-foreground">{skill.description}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className={cn("flex items-center gap-0.5", scoreColor(skill.qualityReview?.score ?? 0))} title="Quality">
                            <Sparkles className="h-3 w-3" />
                            {skill.qualityReview?.score ?? "?"}
                          </span>
                          <span className={cn("flex items-center gap-0.5", scoreColor(skill.securityScore))} title="Security">
                            <Shield className="h-3 w-3" />
                            {skill.securityScore}
                          </span>
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Powered by agentskill.sh</span>
        <a
          href="https://agentskill.sh/skillsets?ref=paperclip"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-foreground/60 hover:text-foreground transition-colors"
        >
          Browse all skillsets <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function AgentSkillShMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M12 2L2 7l10 5 10-5-10-5Z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function sourceMeta(sourceBadge: CompanySkillSourceBadge, sourceLabel: string | null) {
  const normalizedLabel = sourceLabel?.toLowerCase() ?? "";
  const isSkillsShManaged =
    normalizedLabel.includes("skills.sh") || normalizedLabel.includes("vercel-labs/skills");

  switch (sourceBadge) {
    case "agentskill_sh":
      return { icon: AgentSkillShMark, label: sourceLabel ?? "agentskill.sh", managedLabel: "agentskill.sh" };
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
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    return haystack.includes(skillFilter.toLowerCase());
  });

  if (filteredSkills.length === 0) {
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
  onSave: () => void;
  savePending: boolean;
}) {
  const { pushToast } = useToast();

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

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Source</span>
              <span className="flex items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {detail.sourcePath ? (
                  <button
                    className="truncate hover:text-foreground text-muted-foreground transition-colors cursor-pointer"
                    onClick={() => {
                      navigator.clipboard.writeText(detail.sourcePath!);
                      pushToast({ title: "Copied path to workspace" });
                    }}
                  >
                    {source.label}
                  </button>
                ) : detail.sourceType === "agentskill_sh" && detail.sourceLocator ? (
                  <a
                    href={`${detail.sourceLocator}?ref=paperclip`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate hover:text-foreground text-muted-foreground hover:underline transition-colors"
                  >
                    {source.label}
                  </a>
                ) : (
                  <span className="truncate">{source.label}</span>
                )}
              </span>
            </div>
            {detail.sourceType === "agentskill_sh" && detail.sourceLocator && (
              <AgentSkillReview
                slug={(detail.metadata as Record<string, unknown>)?.agentSkillSlug as string ?? detail.slug}
              />
            )}
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
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Used by</span>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">No agents attached</span>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {usedBy.map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.urlKey}/skills`}
                    className="text-foreground no-underline hover:underline"
                  >
                    {agent.name}
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
          <MarkdownBody>{body}</MarkdownBody>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-mono text-sm text-foreground">
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
  const { pushToast } = useToast();
  const [skillFilter, setSkillFilter] = useState("");
  const [source, setSource] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [emptySourceHelpOpen, setEmptySourceHelpOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installingSkillset, setInstallingSkillset] = useState<string | null>(null);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, Set<string>>>({});
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [displayedDetail, setDisplayedDetail] = useState<CompanySkillDetail | null>(null);
  const [displayedFile, setDisplayedFile] = useState<CompanySkillFileDetail | null>(null);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillId = parsedRoute.skillId;
  const selectedPath = parsedRoute.filePath;

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

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message="Select a company to manage skills." />;
  }

  function handleAddSkillSource() {
    const trimmedSource = source.trim();
    if (trimmedSource.length === 0) {
      setBrowseOpen(true);
      return;
    }
    importSkill.mutate(trimmedSource);
  }

  async function handleAgentSkillInstall(slug: string) {
    if (!selectedCompanyId) return;
    setInstallingSlug(slug);
    try {
      const sourceUrl = `https://agentskill.sh/${slug}`;
      await companySkillsApi.importFromSource(selectedCompanyId, sourceUrl);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId) });
      pushToast({ tone: "success", title: "Skill installed", body: slug });
    } catch (error) {
      pushToast({
        tone: "error",
        title: "Install failed",
        body: error instanceof Error ? error.message : `Failed to install ${slug}`,
      });
    } finally {
      setInstallingSlug(null);
    }
  }

  async function handleAgentSkillsetInstall(skillset: AgentSkillset) {
    if (!selectedCompanyId) return;
    setInstallingSkillset(skillset.slug);
    let installed = 0;
    let failed = 0;
    try {
      for (const slug of skillset.skills) {
        try {
          const sourceUrl = `https://agentskill.sh/${slug}`;
          await companySkillsApi.importFromSource(selectedCompanyId, sourceUrl);
          installed++;
        } catch {
          failed++;
        }
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId) });
      pushToast({
        tone: failed > 0 ? "warn" : "success",
        title: `Skillset "${skillset.name}" installed`,
        body: `${installed} skills installed${failed > 0 ? `, ${failed} failed` : ""}`,
      });
    } catch (error) {
      pushToast({
        tone: "error",
        title: "Install failed",
        body: error instanceof Error ? error.message : `Failed to install skillset`,
      });
    } finally {
      setInstallingSkillset(null);
    }
  }

  return (
    <>
      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add a skill</DialogTitle>
            <DialogDescription>
              Browse skills from agentskill.sh, skills.sh, or paste a GitHub URL below.
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="agentskill">
            <TabsList variant="line" className="w-full">
              <TabsTrigger value="agentskill">
                <Search className="h-4 w-4" />
                Skills
              </TabsTrigger>
              <TabsTrigger value="skillsets">
                <Boxes className="h-4 w-4" />
                Skillsets
              </TabsTrigger>
              <TabsTrigger value="other">
                <Github className="h-4 w-4" />
                Other sources
              </TabsTrigger>
            </TabsList>
            <TabsContent value="agentskill" className="mt-3">
              <AgentSkillBrowser
                onInstall={handleAgentSkillInstall}
                installing={installingSlug}
              />
            </TabsContent>
            <TabsContent value="skillsets" className="mt-3">
              <AgentSkillsetBrowser
                onInstallSkillset={handleAgentSkillsetInstall}
                installingSkillset={installingSkillset}
              />
            </TabsContent>
            <TabsContent value="other" className="mt-3">
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
            </TabsContent>
          </Tabs>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="border-r border-border">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h1 className="text-base font-semibold">Skills</h1>
                <p className="text-xs text-muted-foreground">
                  {skillsQuery.data?.length ?? 0} available
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => scanProjects.mutate()}
                  disabled={scanProjects.isPending}
                  title="Scan project workspaces for skills"
                >
                  <RefreshCw className={cn("h-4 w-4", scanProjects.isPending && "animate-spin")} />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setCreateOpen((value) => !value)}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
                placeholder="Filter skills"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
              <input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="Paste path, GitHub URL, or skills.sh command (or click Add to browse)"
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
            onSave={() => saveFile.mutate()}
            savePending={saveFile.isPending}
          />
        </div>
      </div>
    </>
  );
}
