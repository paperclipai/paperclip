import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiscoveryGrid, type DiscoveryCard, type DiscoveryCategory } from "@/pages/CompanySkills";

type DiscoveryTab = "all" | "installed" | "catalog" | "bundled";
type DiscoverySort = "agents" | "stars" | "forks" | "recent" | "alphabetical";

const MOCK_CARDS: DiscoveryCard[] = [
  {
    key: "paperclipai/paperclip/paperclip-dev",
    skillId: "s-dev",
    catalogRef: null,
    name: "paperclip-dev",
    slug: "paperclip-dev",
    author: "Paperclip",
    version: "v2.4.1",
    tagline: "Run and repair local Paperclip workspaces.",
    description: "Develop and operate a local Paperclip instance.",
    categories: ["devops", "coding"],
    iconUrl: null,
    color: null,
    starCount: 48,
    agentCount: 12,
    forkCount: 3,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 2 * 86_400_000,
    sourceBadge: "github",
  },
  {
    key: "here.now/agent-browser",
    skillId: "s-browser",
    catalogRef: null,
    name: "agent-browser",
    slug: "agent-browser",
    author: "here.now",
    version: "v0.8.2",
    tagline: "Drive browsers from an agent loop.",
    description: "Browser automation CLI for AI agents.",
    categories: ["research", "browsers"],
    iconUrl: null,
    color: null,
    starCount: 81,
    agentCount: 9,
    forkCount: 11,
    installed: false,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 5 * 86_400_000,
    sourceBadge: "skills_sh",
  },
  {
    key: "paperclipai/paperclip/verify",
    skillId: "s-verify",
    catalogRef: null,
    name: "verify",
    slug: "verify",
    author: "Paperclip",
    version: "v1.0.3",
    tagline: "Prove the change works in a real app run.",
    description: "Verify a code change works by running the app.",
    categories: ["testing"],
    iconUrl: null,
    color: null,
    starCount: 22,
    agentCount: 7,
    forkCount: 1,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 9 * 86_400_000,
    sourceBadge: "local",
  },
  {
    key: "you/hue-prosumer",
    skillId: "s-hue",
    catalogRef: null,
    name: "hue-prosumer",
    slug: "hue-prosumer",
    author: "you",
    version: "v0.1.0",
    tagline: "Remix a design-language skill for production use.",
    description: "Generate design language skills, prosumer remix.",
    categories: ["design"],
    iconUrl: null,
    color: null,
    starCount: 4,
    agentCount: 2,
    forkCount: 0,
    installed: true,
    required: false,
    forkedFrom: true,
    updatedAt: Date.now() - 1 * 86_400_000,
    sourceBadge: "paperclip",
  },
  {
    key: "anthropic/claude-api",
    skillId: null,
    catalogRef: "c-claude-api",
    name: "claude-api",
    slug: "claude-api",
    author: "Anthropic",
    version: "v1.6.0",
    tagline: "Ship and tune apps on the Claude API.",
    description: "Build, debug and optimize Claude API apps.",
    categories: ["coding", "ai"],
    iconUrl: null,
    color: null,
    starCount: 0,
    agentCount: 0,
    forkCount: 0,
    installed: false,
    required: false,
    forkedFrom: false,
    updatedAt: 0,
    sourceBadge: "url",
  },
  {
    key: "paperclipai/paperclip/security-review",
    skillId: "s-sec",
    catalogRef: null,
    name: "security-review",
    slug: "security-review",
    author: "Paperclip",
    version: "v1.1.0",
    tagline: "Review a branch for concrete security risks.",
    description: "Security review of pending changes on a branch.",
    categories: ["security"],
    iconUrl: null,
    color: null,
    starCount: 29,
    agentCount: 5,
    forkCount: 2,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 3 * 86_400_000,
    sourceBadge: "github",
  },
  {
    key: "yuki/commit-perfect",
    skillId: null,
    catalogRef: "c-commit",
    name: "commit-perfect",
    slug: "commit-perfect",
    author: "Yuki",
    version: "v3.0.1",
    tagline: "Tighten commits and PR metadata before review.",
    description: "Polish commits and PR titles before review.",
    categories: ["git", "workflow"],
    iconUrl: null,
    color: null,
    starCount: 0,
    agentCount: 0,
    forkCount: 0,
    installed: false,
    required: false,
    forkedFrom: false,
    updatedAt: 0,
    sourceBadge: "skills_sh",
  },
  {
    key: "astra/deep-research",
    skillId: "s-research",
    catalogRef: null,
    name: "deep-research",
    slug: "deep-research",
    author: "Astra",
    version: "v2.0.0",
    tagline: "Synthesize multiple sources with citations.",
    description: "Multi-source research with citation-grade synthesis.",
    categories: ["research"],
    iconUrl: null,
    color: null,
    starCount: 211,
    agentCount: 31,
    forkCount: 17,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 4 * 86_400_000,
    sourceBadge: "local",
  },
  {
    key: "paperclipai/paperclip/paperclip",
    skillId: "s-core",
    catalogRef: "c-core",
    name: "paperclip",
    slug: "paperclip",
    author: "Paperclip",
    version: "core",
    tagline: "Coordinate company work through the control plane.",
    description: "Control plane API for tasks, routines, and coordination.",
    categories: ["core"],
    iconUrl: null,
    color: null,
    starCount: 0,
    agentCount: 12,
    forkCount: 0,
    installed: true,
    required: true,
    forkedFrom: false,
    updatedAt: Date.now() - 30 * 86_400_000,
    sourceBadge: "paperclip",
  },
  {
    key: "paperclipai/paperclip/diagnose-why-work-stopped",
    skillId: "s-diag",
    catalogRef: "c-diag",
    name: "diagnose-why-work-stopped",
    slug: "diagnose-why-work-stopped",
    author: "Paperclip",
    version: "core",
    tagline: "Find the exact stop-point in stalled work.",
    description: "Forensics for stalled or looping work trees.",
    categories: ["workflow"],
    iconUrl: null,
    color: null,
    starCount: 0,
    agentCount: 8,
    forkCount: 0,
    installed: true,
    required: true,
    forkedFrom: false,
    updatedAt: Date.now() - 28 * 86_400_000,
    sourceBadge: "url",
  },
];

const DISCOVERY_TABS: DiscoveryTab[] = ["all", "installed", "catalog", "bundled"];

function cardsForTab(cards: DiscoveryCard[], tab: DiscoveryTab): DiscoveryCard[] {
  if (tab === "installed") return cards.filter((c) => c.installed);
  if (tab === "catalog") return cards.filter((c) => c.catalogRef != null);
  if (tab === "bundled") return cards.filter((c) => c.required);
  return cards;
}

function DiscoveryGridHarness({
  initialTab = "all",
  cards = MOCK_CARDS,
}: {
  initialTab?: DiscoveryTab;
  cards?: DiscoveryCard[];
}) {
  const [tab, setTab] = useState<DiscoveryTab>(initialTab);
  const [sort, setSort] = useState<DiscoverySort>("agents");
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const tabCards = useMemo(() => cardsForTab(cards, tab), [cards, tab]);
  const categories = useMemo<DiscoveryCategory[]>(() => {
    const counts = new Map<string, number>();
    for (const card of tabCards) for (const c of card.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ slug, count }))
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  }, [tabCards]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = tabCards.filter((card) => {
      if (category && !card.categories.includes(category)) return false;
      if (!q) return true;
      return `${card.name} ${card.author} ${card.categories.join(" ")}`.toLowerCase().includes(q);
    });
    const demote = tab !== "bundled";
    return [...filtered].sort((a, b) => {
      if (demote && a.required !== b.required) return a.required ? 1 : -1;
      if (sort === "stars") return b.starCount - a.starCount;
      if (sort === "forks") return b.forkCount - a.forkCount;
      if (sort === "recent") return b.updatedAt - a.updatedAt;
      if (sort === "alphabetical") return a.name.localeCompare(b.name);
      return b.agentCount - a.agentCount;
    });
  }, [tabCards, category, search, sort, tab]);

  const tabCounts = useMemo(
    () => ({
      all: cards.length,
      installed: cards.filter((c) => c.installed).length,
      catalog: cards.filter((c) => c.catalogRef != null).length,
      bundled: cards.filter((c) => c.required).length,
    }),
    [cards],
  ) as Record<DiscoveryTab, number>;

  return (
    <DiscoveryGrid
      tab={tab}
      tabCounts={tabCounts}
      onTabChange={(next) => {
        setTab(next);
        setCategory(null);
      }}
      categories={categories}
      categoryTotal={tabCards.length}
      activeCategory={category}
      onCategoryChange={setCategory}
      search={search}
      onSearchChange={setSearch}
      sort={sort}
      onSortChange={setSort}
      cards={visible}
      onOpenCard={() => {}}
      loading={false}
      error={null}
      totalCount={cards.length}
      onCreate={() => {}}
      onImport={() => {}}
      onImportFromProject={() => {}}
      onBrowseCatalog={() => setTab("catalog")}
      onScan={() => {}}
      scanPending={false}
      scanStatus={null}
    />
  );
}

const meta: Meta<typeof DiscoveryGridHarness> = {
  title: "Skills Store/Discovery grid",
  component: DiscoveryGridHarness,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof DiscoveryGridHarness>;

export const AllSkills: Story = { args: { initialTab: "all" } };
export const InstalledTab: Story = { args: { initialTab: "installed" } };
export const BundledRequiredTab: Story = { args: { initialTab: "bundled" } };
export const EmptyLibrary: Story = { args: { initialTab: "all", cards: [] } };
