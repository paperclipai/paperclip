import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, brandKits, brandKitAssets } from "@paperclipai/db";
import { parseDesignMd, type BrandKitValidationError } from "@paperclipai/shared";

export type BrandKitRow = typeof brandKits.$inferSelect;

// A kit asset joined with its underlying asset record (NEO-269).
export interface BrandKitAssetView {
  id: string;
  brandKitId: string;
  assetId: string;
  role: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdAt: Date;
}

export type BrandKitWriteResult =
  | { ok: true; kit: BrandKitRow }
  | { ok: false; errors: BrandKitValidationError[] };

// Thrown for unique-constraint / not-found conditions the route maps to 4xx.
export class BrandKitConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandKitConflictError";
  }
}

const SLUG_MAX = 80;

// Derive a URL-safe slug from a display name. Matches brandKitSlugSchema.
export function slugifyBrandKitName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return base || "brand-kit";
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export function brandKitService(db: Db) {
  async function listKits(companyId: string): Promise<BrandKitRow[]> {
    return db
      .select()
      .from(brandKits)
      .where(and(eq(brandKits.companyId, companyId), isNull(brandKits.archivedAt)))
      .orderBy(desc(brandKits.isDefault), asc(brandKits.name));
  }

  async function getKit(companyId: string, kitId: string): Promise<BrandKitRow | null> {
    const rows = await db
      .select()
      .from(brandKits)
      .where(and(eq(brandKits.id, kitId), eq(brandKits.companyId, companyId)));
    return rows[0] ?? null;
  }

  async function getDefaultKit(companyId: string): Promise<BrandKitRow | null> {
    const rows = await db
      .select()
      .from(brandKits)
      .where(
        and(
          eq(brandKits.companyId, companyId),
          eq(brandKits.isDefault, true),
          isNull(brandKits.archivedAt),
        ),
      );
    return rows[0] ?? null;
  }

  async function hasDefault(companyId: string): Promise<boolean> {
    return (await getDefaultKit(companyId)) !== null;
  }

  // Parse a DESIGN.md payload into a token cache, or surface validation errors.
  function tokensFor(designMd: string): BrandKitWriteResult | { tokens: Record<string, unknown> } {
    if (!designMd.trim()) return { tokens: {} };
    const parsed = parseDesignMd(designMd);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    return { tokens: parsed.document.tokens as unknown as Record<string, unknown> };
  }

  async function createKit(
    companyId: string,
    input: { name: string; slug?: string; designMd?: string; setDefault?: boolean },
  ): Promise<BrandKitWriteResult> {
    const designMd = input.designMd ?? "";
    const tokensResult = tokensFor(designMd);
    if ("ok" in tokensResult) return tokensResult;

    const slug = input.slug ?? slugifyBrandKitName(input.name);
    const becomeDefault = input.setDefault === true || !(await hasDefault(companyId));

    try {
      const kit = await db.transaction(async (tx) => {
        if (becomeDefault) {
          await tx
            .update(brandKits)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(and(eq(brandKits.companyId, companyId), eq(brandKits.isDefault, true)));
        }
        const rows = await tx
          .insert(brandKits)
          .values({
            companyId,
            name: input.name,
            slug,
            isDefault: becomeDefault,
            designMd,
            tokens: tokensResult.tokens,
          })
          .returning();
        return rows[0];
      });
      return { ok: true, kit };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BrandKitConflictError(`A brand kit with slug "${slug}" already exists in this company`);
      }
      throw err;
    }
  }

  // Upsert DESIGN.md for an existing kit: parse/validate then rebuild token cache.
  async function updateDesign(
    companyId: string,
    kitId: string,
    input: { designMd: string; name?: string },
  ): Promise<BrandKitWriteResult | null> {
    const existing = await getKit(companyId, kitId);
    if (!existing) return null;

    const tokensResult = tokensFor(input.designMd);
    if ("ok" in tokensResult) return tokensResult;

    const rows = await db
      .update(brandKits)
      .set({
        designMd: input.designMd,
        tokens: tokensResult.tokens,
        ...(input.name ? { name: input.name } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(brandKits.id, kitId), eq(brandKits.companyId, companyId)))
      .returning();
    return { ok: true, kit: rows[0] };
  }

  // Set a kit as the company default. Clears the prior default in the same tx so
  // the partial-unique index (one default per company) is never violated.
  async function setDefault(companyId: string, kitId: string): Promise<BrandKitRow> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(brandKits)
        .where(
          and(eq(brandKits.id, kitId), eq(brandKits.companyId, companyId), isNull(brandKits.archivedAt)),
        );
      const kit = rows[0];
      if (!kit) throw new BrandKitConflictError("Brand kit not found");

      if (!kit.isDefault) {
        await tx
          .update(brandKits)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(brandKits.companyId, companyId), eq(brandKits.isDefault, true)));
        const updated = await tx
          .update(brandKits)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(brandKits.id, kitId))
          .returning();
        return updated[0];
      }
      return kit;
    });
  }

  async function listAssets(brandKitId: string): Promise<BrandKitAssetView[]> {
    const rows = await db
      .select({
        id: brandKitAssets.id,
        brandKitId: brandKitAssets.brandKitId,
        assetId: brandKitAssets.assetId,
        role: brandKitAssets.role,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdAt: brandKitAssets.createdAt,
      })
      .from(brandKitAssets)
      .innerJoin(assets, eq(brandKitAssets.assetId, assets.id))
      .where(eq(brandKitAssets.brandKitId, brandKitId))
      .orderBy(asc(brandKitAssets.role));
    return rows;
  }

  // Bind an asset to a kit slot. One asset per (kit, role) — re-binding a role
  // swaps the asset.
  async function attachAsset(brandKitId: string, assetId: string, role: string) {
    const rows = await db
      .insert(brandKitAssets)
      .values({ brandKitId, assetId, role })
      .onConflictDoUpdate({
        target: [brandKitAssets.brandKitId, brandKitAssets.role],
        set: { assetId, updatedAt: new Date() },
      })
      .returning();
    return rows[0];
  }

  async function detachAsset(brandKitId: string, assetId: string): Promise<number> {
    const rows = await db
      .delete(brandKitAssets)
      .where(and(eq(brandKitAssets.brandKitId, brandKitId), eq(brandKitAssets.assetId, assetId)))
      .returning({ id: brandKitAssets.id });
    return rows.length;
  }

  return {
    listKits,
    getKit,
    getDefaultKit,
    hasDefault,
    createKit,
    updateDesign,
    setDefault,
    listAssets,
    attachAsset,
    detachAsset,
  };
}
