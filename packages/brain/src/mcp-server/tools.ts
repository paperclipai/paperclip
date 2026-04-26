import type { BrainDbHandle } from "../db/client.js";
import type { Embedder } from "../indexer/embedder.js";
import { getAgentScope, isAgentExcludedByFrontmatter } from "./acl.js";
import type { SearchHit } from "../shared/types.js";

export interface ToolDeps {
  handle: BrainDbHandle;
  embed: Embedder;
}

export interface SearchArgs {
  query: string;
  agentId: string;
  limit?: number;
  folderFilter?: string[];
}

export interface GetNoteArgs {
  path: string;
  agentId: string;
}

export interface ListScopeArgs {
  agentId: string;
}

export interface ListScopeResult {
  allowedFolders: string[];
  noteCount: number;
}

export interface FullNote {
  path: string;
  title: string | null;
  folder: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

interface SearchRow {
  path: string;
  title: string | null;
  folder: string;
  frontmatter: Record<string, unknown>;
  heading_path: string[] | null;
  content: string;
  score: number;
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export interface BrainTools {
  search_vault: (args: SearchArgs) => Promise<SearchHit[]>;
  get_note: (args: GetNoteArgs) => Promise<FullNote | null>;
  list_scope: (args: ListScopeArgs) => Promise<ListScopeResult>;
}

export function createTools(deps: ToolDeps): BrainTools {
  const { handle, embed } = deps;

  return {
    async search_vault(args: SearchArgs): Promise<SearchHit[]> {
      const limit = args.limit ?? 8;
      const scope = await getAgentScope(handle.db, args.agentId);
      let folders = scope.allowedFolders;
      if (args.folderFilter && args.folderFilter.length > 0) {
        folders = folders.filter((f) => args.folderFilter!.includes(f));
      }
      if (folders.length === 0) return [];

      const [qvec] = await embed.embedBatch([args.query]);
      if (!qvec) return [];
      const emb = vectorLiteral(qvec);

      const rows = await handle.sql<SearchRow[]>`
        SELECT n.path,
               n.title,
               n.folder,
               n.frontmatter,
               c.heading_path,
               c.content,
               1 - (c.embedding <=> ${emb}::vector) AS score
        FROM brain.chunks c
        JOIN brain.notes n ON n.id = c.note_id
        WHERE n.folder = ANY(${folders}::text[])
          AND (
            n.frontmatter->'agent_exclude' IS NULL
            OR NOT (n.frontmatter->'agent_exclude' ? ${args.agentId})
          )
          AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${emb}::vector
        LIMIT ${limit * 3}
      `;

      const byPath = new Map<string, SearchHit>();
      for (const r of rows) {
        const score = Number(r.score);
        const existing = byPath.get(r.path);
        if (!existing || score > existing.score) {
          byPath.set(r.path, {
            path: r.path,
            title: r.title,
            headingPath: r.heading_path ?? [],
            content: r.content.slice(0, 3200),
            score,
            folder: r.folder,
            frontmatter: r.frontmatter,
          });
        }
      }
      return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },

    async get_note(args: GetNoteArgs): Promise<FullNote | null> {
      const scope = await getAgentScope(handle.db, args.agentId);
      const rows = await handle.sql<
        Array<{
          path: string;
          title: string | null;
          folder: string;
          frontmatter: Record<string, unknown>;
          body: string | null;
        }>
      >`
        SELECT n.path, n.title, n.folder, n.frontmatter,
               string_agg(c.content, E'\n\n' ORDER BY c.chunk_index) AS body
        FROM brain.notes n
        LEFT JOIN brain.chunks c ON c.note_id = n.id
        WHERE n.path = ${args.path}
        GROUP BY n.id, n.path, n.title, n.folder, n.frontmatter
      `;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      if (!scope.allowedFolders.includes(r.folder)) return null;
      if (isAgentExcludedByFrontmatter(args.agentId, r.frontmatter)) return null;
      return {
        path: r.path,
        title: r.title,
        folder: r.folder,
        frontmatter: r.frontmatter,
        body: r.body ?? "",
      };
    },

    async list_scope(args: ListScopeArgs): Promise<ListScopeResult> {
      const scope = await getAgentScope(handle.db, args.agentId);
      if (scope.allowedFolders.length === 0) {
        return { allowedFolders: [], noteCount: 0 };
      }
      const rows = await handle.sql<Array<{ count: string }>>`
        SELECT count(*)::text AS count
        FROM brain.notes
        WHERE folder = ANY(${scope.allowedFolders}::text[])
      `;
      return {
        allowedFolders: scope.allowedFolders,
        noteCount: Number(rows[0]?.count ?? 0),
      };
    },
  };
}
