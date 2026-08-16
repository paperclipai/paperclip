import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export type WikiKnowledgeAuthor = {
  kind: "agent" | "user" | "plugin";
  id?: string | null;
  runId?: string | null;
};

export type ParsedWikiProperties = {
  frontmatter: Record<string, string | string[] | boolean | number | null>;
  aliases: string[];
  tags: string[];
};

function table(ctx: PluginContext, name: string): string {
  return `${ctx.db.namespace}.${name}`;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/^#/, ""))
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function parseScalar(raw: string): string | string[] | boolean | number | null {
  const value = raw.trim();
  if (!value || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((entry) => entry.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  return value.replace(/^['"]|['"]$/g, "");
}

export function parseWikiProperties(contents: string): ParsedWikiProperties {
  const frontmatter: Record<string, string | string[] | boolean | number | null> = {};
  if (contents.startsWith("---\n") || contents.startsWith("---\r\n")) {
    const lines = contents.replace(/\r\n/g, "\n").split("\n");
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      let listKey: string | null = null;
      for (const line of lines.slice(1, end)) {
        const listMatch = line.match(/^\s*-\s+(.+)$/);
        if (listMatch && listKey) {
          const current = frontmatter[listKey];
          const values = Array.isArray(current) ? current : current == null ? [] : [String(current)];
          values.push(String(parseScalar(listMatch[1] ?? "")));
          frontmatter[listKey] = values;
          continue;
        }
        const pair = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (!pair) continue;
        listKey = pair[1] ?? null;
        frontmatter[pair[1]!] = parseScalar(pair[2] ?? "");
      }
    }
  }
  const aliases = uniqueStrings([frontmatter.aliases, frontmatter.alias]);
  const frontmatterTags = uniqueStrings([frontmatter.tags, frontmatter.tag]);
  const bodyTags = [...contents.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)].map((match) => match[1] ?? "");
  return { frontmatter, aliases, tags: uniqueStrings([...frontmatterTags, ...bodyTags]) };
}

function stripCode(contents: string): string {
  return contents.replace(/```[\s\S]*?```/g, "").replace(/`[^`\r\n]*`/g, "");
}

export type ExtractedWikiRelation = {
  target: string;
  label: string | null;
  relationType: string;
};

export function extractWikiRelations(contents: string): ExtractedWikiRelation[] {
  const relations = new Map<string, ExtractedWikiRelation>();
  const clean = stripCode(contents);
  for (const match of clean.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    const [rawTarget, rawLabel] = (match[1] ?? "").split("|", 2);
    const target = rawTarget?.split("#", 1)[0]?.trim();
    if (!target) continue;
    const relation = { target, label: rawLabel?.trim() || null, relationType: "links_to" };
    const key = `${relation.target}\0${relation.relationType}`;
    const existing = relations.get(key);
    relations.set(key, existing?.label && !relation.label ? existing : relation);
  }
  for (const match of clean.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const rawTarget = match[2]?.split("#", 1)[0]?.trim() ?? "";
    if (!rawTarget || /^[a-z][a-z\d+.-]*:/i.test(rawTarget) || rawTarget.startsWith("//")) continue;
    const relation = { target: rawTarget, label: match[1]?.trim() || null, relationType: "links_to" };
    relations.set(`${relation.target}\0${relation.relationType}`, relation);
  }
  return [...relations.values()];
}

function logicalTargetPath(target: string): string {
  const clean = target.trim().replace(/^\/+/, "");
  if (clean.toLowerCase().endsWith(".md")) return clean;
  if (clean.includes("/")) return `${clean}.md`;
  return `wiki/${clean}.md`;
}

type PageCandidate = {
  id: string;
  space_id: string;
  path: string;
  title: string | null;
  aliases: unknown;
};

function candidateAliases(candidate: PageCandidate): string[] {
  return Array.isArray(candidate.aliases)
    ? candidate.aliases.filter((value): value is string => typeof value === "string")
    : [];
}

async function resolveRelationTarget(
  ctx: PluginContext,
  input: { companyId: string; wikiId: string; sourceSpaceId: string; target: string },
): Promise<{ page: PageCandidate | null; targetPath: string; ambiguous: boolean }> {
  const explicitSpace = input.target.match(/^@([^:]+):(.+)$/);
  const targetText = explicitSpace?.[2]?.trim() ?? input.target;
  const normalizedPath = logicalTargetPath(targetText);
  const candidates = await ctx.db.query<PageCandidate>(
    `SELECT p.id, p.space_id, p.path, p.title, p.aliases
       FROM ${table(ctx, "wiki_pages")} p
       JOIN ${table(ctx, "wiki_spaces")} s ON s.id = p.space_id
      WHERE p.company_id = $1 AND p.wiki_id = $2 AND p.deleted_at IS NULL
        AND ($3::text IS NULL OR s.slug = $3)`,
    [input.companyId, input.wikiId, explicitSpace?.[1] ?? null],
  );
  const needle = targetText.replace(/\.md$/i, "").trim().toLowerCase();
  const exactPath = candidates.filter((candidate) => candidate.path.toLowerCase() === normalizedPath.toLowerCase());
  const sameSpacePath = exactPath.filter((candidate) => candidate.space_id === input.sourceSpaceId);
  if (sameSpacePath.length === 1) return { page: sameSpacePath[0]!, targetPath: sameSpacePath[0]!.path, ambiguous: false };
  if (exactPath.length === 1) return { page: exactPath[0]!, targetPath: exactPath[0]!.path, ambiguous: false };
  const titled = candidates.filter((candidate) => {
    const title = candidate.title?.trim().toLowerCase();
    const basename = candidate.path.split("/").pop()?.replace(/\.md$/i, "").toLowerCase();
    return title === needle || basename === needle || candidateAliases(candidate).some((alias) => alias.toLowerCase() === needle);
  });
  const sameSpaceTitle = titled.filter((candidate) => candidate.space_id === input.sourceSpaceId);
  if (sameSpaceTitle.length === 1) return { page: sameSpaceTitle[0]!, targetPath: sameSpaceTitle[0]!.path, ambiguous: false };
  if (titled.length === 1) return { page: titled[0]!, targetPath: titled[0]!.path, ambiguous: false };
  return { page: null, targetPath: normalizedPath, ambiguous: exactPath.length > 1 || titled.length > 1 };
}

export async function syncPageKnowledgeIndex(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  path: string;
  contents: string;
  author?: WikiKnowledgeAuthor | null;
}): Promise<{ aliases: string[]; tags: string[]; relationCount: number }> {
  const properties = parseWikiProperties(input.contents);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "wiki_pages")}
        SET frontmatter = $5::jsonb,
            aliases = $6::jsonb,
            tags = $7::jsonb,
            updated_by_kind = COALESCE($8, updated_by_kind),
            updated_by_id = COALESCE($9, updated_by_id),
            created_by_kind = COALESCE(created_by_kind, $8),
            created_by_id = COALESCE(created_by_id, $9)
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4`,
    [
      input.companyId,
      input.wikiId,
      input.spaceId,
      input.path,
      JSON.stringify(properties.frontmatter),
      JSON.stringify(properties.aliases),
      JSON.stringify(properties.tags),
      input.author?.kind ?? null,
      input.author?.id ?? null,
    ],
  );
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "wiki_relations")}
      WHERE company_id = $1 AND wiki_id = $2 AND source_space_id = $3 AND source_path = $4 AND origin_kind = 'markdown'`,
    [input.companyId, input.wikiId, input.spaceId, input.path],
  );
  const sourceRows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4 AND deleted_at IS NULL LIMIT 1`,
    [input.companyId, input.wikiId, input.spaceId, input.path],
  );
  const sourcePageId = sourceRows[0]?.id ?? null;
  const extracted = extractWikiRelations(input.contents);
  for (const relation of extracted) {
    const resolved = await resolveRelationTarget(ctx, {
      companyId: input.companyId,
      wikiId: input.wikiId,
      sourceSpaceId: input.spaceId,
      target: relation.target,
    });
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "wiki_relations")}
         (id, company_id, wiki_id, source_space_id, source_page_id, source_path,
          target_kind, target_space_id, target_page_id, target_path, target_ref,
          relation_type, label, origin_kind, metadata, created_by_kind, created_by_id, created_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'wiki_page', $7, $8, $9, $10, $11, $12, 'markdown', $13::jsonb, $14, $15, $16)`,
      [
        randomUUID(), input.companyId, input.wikiId, input.spaceId, sourcePageId, input.path,
        resolved.page?.space_id ?? null, resolved.page?.id ?? null, resolved.targetPath, relation.target,
        relation.relationType, relation.label,
        JSON.stringify({ resolved: Boolean(resolved.page), ambiguous: resolved.ambiguous }),
        input.author?.kind ?? null, input.author?.id ?? null, input.author?.runId ?? null,
      ],
    );
  }
  return { aliases: properties.aliases, tags: properties.tags, relationCount: extracted.length };
}
