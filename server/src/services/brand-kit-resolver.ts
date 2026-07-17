import type { Db } from "@paperclipai/db";
import { parseDesignMd, type BrandKitDocument } from "@paperclipai/shared";
import { brandKitService } from "./brand-kits.js";

// Context the resolver keys off. Phase 1 (NEO-269) only uses companyId; the
// issue/project/goal fields are accepted now so NEO-248 can layer scoped-override
// tiers on top without changing any call site.
export interface BrandKitResolveContext {
  companyId: string;
  issueId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
}

export interface ResolvedBrandKitAsset {
  role: string;
  assetId: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  // Route a consumer can GET to fetch the raw bytes (company-scoped auth applies).
  contentPath: string;
}

export interface ResolvedBrandKit {
  // How the active kit was selected. "none" means the company has no kit.
  source: "company_default" | "none";
  kit: {
    id: string;
    name: string;
    slug: string;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  designMd: string | null;
  // Parsed artifact (tokens + prose body); null if the stored DESIGN.md is empty
  // or somehow no longer parses.
  document: BrandKitDocument | null;
  // Cached parsed tokens (mirrors brand_kits.tokens).
  tokens: Record<string, unknown>;
  assets: ResolvedBrandKitAsset[];
}

export function assetContentPath(assetId: string): string {
  return `/api/assets/${assetId}/content`;
}

const EMPTY: ResolvedBrandKit = {
  source: "none",
  kit: null,
  designMd: null,
  document: null,
  tokens: {},
  assets: [],
};

/**
 * Resolve the active brand kit for a context.
 *
 * Phase 1: the active kit is the company default. The signature accepts richer
 * context (issue/project/goal) so future tiers can override without a call-site
 * change (NEO-248). Returns a `source: "none"` result when no kit exists.
 */
export async function resolveBrandKit(
  db: Db,
  context: BrandKitResolveContext,
): Promise<ResolvedBrandKit> {
  const svc = brandKitService(db);
  const kit = await svc.getDefaultKit(context.companyId);
  if (!kit) return { ...EMPTY };

  const parsed = kit.designMd.trim() ? parseDesignMd(kit.designMd) : null;
  const document = parsed && parsed.ok ? parsed.document : null;

  const assetRows = await svc.listAssets(kit.id);
  const assets: ResolvedBrandKitAsset[] = assetRows.map((row) => ({
    role: row.role,
    assetId: row.assetId,
    contentType: row.contentType,
    byteSize: row.byteSize,
    originalFilename: row.originalFilename,
    contentPath: assetContentPath(row.assetId),
  }));

  return {
    source: "company_default",
    kit: {
      id: kit.id,
      name: kit.name,
      slug: kit.slug,
      isDefault: kit.isDefault,
      createdAt: kit.createdAt,
      updatedAt: kit.updatedAt,
    },
    designMd: kit.designMd,
    document,
    tokens: kit.tokens ?? {},
    assets,
  };
}
