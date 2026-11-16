import { and, eq, inArray, lte } from "drizzle-orm";
import { linkPreviews, type Db } from "@paperclipai/db";
import type { LinkPreviewResult, LinkPreviewTarget } from "@paperclipai/shared";
import type { LinkPreviewScope } from "./link-previews.js";

export interface StoredLinkPreview { result: LinkPreviewResult; expiresAt: number; checkedAt: number }
export interface LinkPreviewStore {
  read(scope: LinkPreviewScope, targets: readonly LinkPreviewTarget[]): Promise<Map<string, StoredLinkPreview>>;
  write(scope: LinkPreviewScope, target: LinkPreviewTarget, entry: Omit<StoredLinkPreview, "checkedAt">, checkedAt: number): Promise<void>;
}

export function createLinkPreviewStore(db: Db): LinkPreviewStore {
  return {
    async read(scope, targets) {
      if (!targets.length) return new Map();
      // One covering identity-index lookup for the page, never a task join or a provider call.
      const rows = await db.select().from(linkPreviews).where(and(
        eq(linkPreviews.companyId, scope.companyId), eq(linkPreviews.viewerId, scope.userId ?? ""),
        inArray(linkPreviews.canonicalUrl, targets.map(target => target.canonicalUrl)),
      ));
      const byUrl = new Map(targets.map(target => [target.canonicalUrl, target]));
      return new Map(rows.flatMap(row => {
        const target = byUrl.get(row.canonicalUrl);
        if (!target || target.provider !== row.channel || target.kind !== row.resourceKind) return [];
        const data = row.metadata;
        const preview = row.status !== null && typeof data.title === "string" ? {
          target, title: data.title, state: row.status as NonNullable<LinkPreviewResult["preview"]>["state"],
          author: typeof data.author === "string" ? data.author : null,
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
        } : null;
        return [[row.canonicalUrl, { result: { preview, maxAgeMs: 0 }, expiresAt: row.expiresAt.getTime(), checkedAt: row.checkedAt.getTime() }] as const];
      }));
    },
    async write(scope, target, entry, checkedAt) {
      const preview = entry.result.preview;
      const values = {
        companyId: scope.companyId, viewerId: scope.userId ?? "", channel: target.provider,
        resourceKind: target.kind, canonicalUrl: target.canonicalUrl, status: preview?.state ?? null,
        metadata: preview ? { title: preview.title, author: preview.author, updatedAt: preview.updatedAt } : {},
        checkedAt: new Date(checkedAt), expiresAt: new Date(entry.expiresAt),
      };
      await db.insert(linkPreviews).values(values).onConflictDoUpdate({
        target: [linkPreviews.companyId, linkPreviews.viewerId, linkPreviews.canonicalUrl],
        set: values, setWhere: lte(linkPreviews.checkedAt, values.checkedAt),
      });
    },
  };
}
