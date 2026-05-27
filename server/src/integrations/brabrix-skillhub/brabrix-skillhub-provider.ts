import { logger } from "../../middleware/logger.js";
import { BrabrixSkillHubClient, getBrabrixSkillHubConfig } from "./brabrix-skillhub-client.js";
import type {
  BrabrixSkillHubCategory,
  BrabrixSkillHubConfig,
  BrabrixSkillHubSearchParams,
  BrabrixSkillHubSkill,
} from "./brabrix-skillhub-types.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function buildSearchCacheKey(params: BrabrixSkillHubSearchParams): string {
  const tags = (params.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0).sort();
  return JSON.stringify({
    q: params.query?.trim().toLowerCase() ?? "",
    category: params.category?.trim().toLowerCase() ?? "",
    tags,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
  });
}

function estimateSkillContextSize(skill: BrabrixSkillHubSkill): number {
  const base = [skill.name, skill.summary ?? "", skill.description ?? ""].join(" ").length;
  const blocks = skill.contentBlocks.reduce((acc, block) => acc + (block.title?.length ?? 0) + block.content.length, 0);
  return base + blocks;
}

export interface BrabrixSkillHubProviderOptions {
  config?: BrabrixSkillHubConfig;
  client?: BrabrixSkillHubClient;
  cacheTtlMs?: number;
}

export class BrabrixSkillHubProvider {
  private readonly client: BrabrixSkillHubClient;
  private readonly log = logger.child({ service: "brabrix-skillhub-provider" });
  private readonly cacheTtlMs: number;
  private readonly skillCache = new Map<string, CacheEntry<BrabrixSkillHubSkill | null>>();
  private readonly searchCache = new Map<string, CacheEntry<BrabrixSkillHubSkill[]>>();
  private readonly categoriesCache = new Map<string, CacheEntry<BrabrixSkillHubCategory[]>>();

  constructor(options: BrabrixSkillHubProviderOptions = {}) {
    const config = options.config ?? getBrabrixSkillHubConfig();
    this.client = options.client ?? new BrabrixSkillHubClient(config);
    this.cacheTtlMs = Math.max(5_000, options.cacheTtlMs ?? 120_000);
  }

  isEnabled(): boolean {
    return this.client.isEnabled();
  }

  private getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
    const cached = map.get(key);
    if (!cached) return null;
    if (Date.now() >= cached.expiresAt) {
      map.delete(key);
      return null;
    }
    return cached.value;
  }

  private setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
    map.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  async searchSkills(params: BrabrixSkillHubSearchParams = {}): Promise<BrabrixSkillHubSkill[]> {
    const normalized: BrabrixSkillHubSearchParams = {
      query: params.query?.trim() || null,
      category: params.category?.trim() || null,
      tags: params.tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0) ?? [],
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    };
    const key = buildSearchCacheKey(normalized);
    const cached = this.getCached(this.searchCache, key);
    if (cached) {
      this.log.debug({
        provider: "brabrix_skillhub",
        query: normalized.query,
        category: normalized.category,
        tags: normalized.tags,
        count: cached.length,
        cached: true,
      }, "skill search result served from cache");
      return cached;
    }

    const normalizedQuery = normalized.query ? normalizeText(normalized.query) : null;
    const normalizedCategory = normalized.category ? normalizeText(normalized.category) : null;
    const normalizedTags = (normalized.tags ?? []).map(normalizeText);

    const result = await this.client.searchSkills(normalized);
    const filtered = result.skills.filter((skill) => {
      if (normalizedCategory) {
        const skillCategory = skill.category ? normalizeText(skill.category) : "";
        if (skillCategory !== normalizedCategory) return false;
      }
      if (normalizedTags.length > 0) {
        const skillTags = new Set(skill.tags.map(normalizeText));
        if (!normalizedTags.every((tag) => skillTags.has(tag))) return false;
      }
      if (normalizedQuery) {
        const haystack = [
          skill.slug,
          skill.name,
          skill.summary ?? "",
          skill.description ?? "",
          skill.category ?? "",
          ...skill.tags,
        ].map(normalizeText).join(" ");
        if (!haystack.includes(normalizedQuery)) return false;
      }
      return true;
    });

    this.setCached(this.searchCache, key, filtered);
    this.log.info({
      provider: "brabrix_skillhub",
      query: normalized.query,
      category: normalized.category,
      tags: normalized.tags,
      count: filtered.length,
      total: result.total,
      cached: false,
    }, "skills searched from Brabrix SkillHub");
    return filtered;
  }

  async getSkillById(skillId: string): Promise<BrabrixSkillHubSkill | null> {
    const normalizedId = skillId.trim();
    if (!normalizedId) return null;
    const cached = this.getCached(this.skillCache, normalizedId);
    if (cached !== null) return cached;
    const skill = await this.client.getSkillById(normalizedId);
    this.setCached(this.skillCache, normalizedId, skill);
    if (skill) {
      const estimatedChars = estimateSkillContextSize(skill);
      this.log.debug({
        provider: "brabrix_skillhub",
        skillId: skill.id,
        slug: skill.slug,
        contentBlocks: skill.contentBlocks.length,
        estimatedChars,
      }, "skill detail loaded from Brabrix SkillHub");
    }
    return skill;
  }

  async importSkill(skillIdOrSlug: string): Promise<BrabrixSkillHubSkill | null> {
    const input = skillIdOrSlug.trim();
    if (!input) return null;

    const byId = await this.getSkillById(input);
    if (byId) {
      const estimatedChars = estimateSkillContextSize(byId);
      this.log.info({
        provider: "brabrix_skillhub",
        skillId: byId.id,
        slug: byId.slug,
        estimatedChars,
      }, "skill imported from Brabrix SkillHub");
      return byId;
    }

    const candidates = await this.searchSkills({ query: input, limit: 20 });
    const normalizedInput = normalizeText(input);
    const bySlug = candidates.find((skill) =>
      normalizeText(skill.slug) === normalizedInput || normalizeText(skill.id) === normalizedInput);
    if (!bySlug) return null;

    this.setCached(this.skillCache, bySlug.id, bySlug);
    const estimatedChars = estimateSkillContextSize(bySlug);
    this.log.info({
      provider: "brabrix_skillhub",
      skillId: bySlug.id,
      slug: bySlug.slug,
      estimatedChars,
      matchedBy: "search",
    }, "skill imported from Brabrix SkillHub");
    return bySlug;
  }

  async getSkillCategories(): Promise<BrabrixSkillHubCategory[]> {
    const cacheKey = "all";
    const cached = this.getCached(this.categoriesCache, cacheKey);
    if (cached) return cached;
    const categories = await this.client.getSkillCategories();
    this.setCached(this.categoriesCache, cacheKey, categories);
    return categories;
  }

  async getFeaturedSkills(limit = 12): Promise<BrabrixSkillHubSkill[]> {
    const cacheKey = `featured:${limit}`;
    const cached = this.getCached(this.searchCache, cacheKey);
    if (cached) {
      this.log.debug({
        provider: "brabrix_skillhub",
        count: cached.length,
        limit,
        cached: true,
      }, "featured skills served from cache");
      return cached;
    }

    const featured = await this.client.getFeaturedSkills(limit);
    this.setCached(this.searchCache, cacheKey, featured);
    this.log.info({
      provider: "brabrix_skillhub",
      count: featured.length,
      limit,
      cached: false,
    }, "featured skills loaded from Brabrix SkillHub");
    return featured;
  }
}
