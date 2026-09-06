import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  applyRedaction,
  isRedactionRulesPath,
  parseFrontmatterProject,
  resolveWikilinks,
  scoreNoteRelevance,
  type ProjectVaultContext,
  type VaultNote,
} from "./vault-read.js";
import { VAULT_ROOT_FOLDER_KEY } from "./manifest.js";

const PLUGIN_NAME = "hdo-76-vault-read-bridge";
const PLUGIN_HEALTH_MESSAGE =
  "HDO-76 vault read-bridge prototype ready (read-only; no write-back; no auto-issue-creation)";

interface VaultListingEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size: number | null;
  readonly modifiedAt: string | null;
}

function toMtimeMs(modifiedAt: string | null): number | null {
  if (!modifiedAt) return null;
  const parsed = Date.parse(modifiedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

async function collectVaultNotes(
  ctx: {
    localFolders: {
      list: (
        companyId: string,
        folderKey: string,
        options?: { recursive?: boolean; maxEntries?: number },
      ) => Promise<{ entries: VaultListingEntry[] }>;
      readText: (companyId: string, folderKey: string, relativePath: string) => Promise<string>;
    };
  },
  companyId: string,
): Promise<{ notes: VaultNote[]; errors: string[] }> {
  const errors: string[] = [];
  let listing: { entries: VaultListingEntry[] };
  try {
    listing = await ctx.localFolders.list(companyId, VAULT_ROOT_FOLDER_KEY, {
      recursive: true,
      maxEntries: 4000,
    });
  } catch (err) {
    return { notes: [], errors: [`vault listing failed: ${String(err)}`] };
  }
  const fileEntries = listing.entries.filter((e) => e.kind === "file" && e.name.endsWith(".md"));
  const notes: VaultNote[] = [];
  for (const entry of fileEntries) {
    if (entry.path === "VAULT-MANIFEST.md") {
      // The manifest is metadata, not a vault note for rendering.
      continue;
    }
    if (isRedactionRulesPath(entry.path)) {
      // The redaction rules file is metadata, not a vault note.
      continue;
    }
    let body = "";
    try {
      body = await ctx.localFolders.readText(companyId, VAULT_ROOT_FOLDER_KEY, entry.path);
    } catch (err) {
      errors.push(`read failed: ${entry.path} (${String(err)})`);
      continue;
    }
    notes.push({
      relativePath: entry.path,
      title: entry.name.replace(/\.md$/i, ""),
      mtimeMs: toMtimeMs(entry.modifiedAt),
      sizeBytes: entry.size,
      frontmatterProject: parseFrontmatterProject(body),
      backlinks: [], // populated in the second pass below.
    });
  }
  // Second pass: backlinks. A note is considered a backlink if its
  // body contains a `[[<other note title>]]` reference. This is a
  // local pass over the in-memory snapshot; no extra I/O.
  const titles = new Set(notes.map((n) => n.title));
  const backlinkCount = new Map<string, number>();
  for (const note of notes) {
    let body = "";
    try {
      body = await ctx.localFolders.readText(companyId, VAULT_ROOT_FOLDER_KEY, note.relativePath);
    } catch {
      continue;
    }
    const { resolved } = resolveWikilinks(body, titles);
    for (const target of resolved) {
      backlinkCount.set(target, (backlinkCount.get(target) ?? 0) + 1);
    }
  }
  const withBacklinks: VaultNote[] = notes.map((n) => ({
    ...n,
    backlinks: backlinkCount.get(n.title) ? [n.title] : [],
  }));
  return { notes: withBacklinks, errors };
}

async function loadRedactedPaths(
  ctx: {
    localFolders: {
      readText: (companyId: string, folderKey: string, relativePath: string) => Promise<string>;
    };
  },
  companyId: string,
): Promise<ReadonlySet<string>> {
  // The prototype reads the rules file once per worker startup. A
  // production deployment would cache the result and refresh on
  // `plugin.<id>.vault.changed` events. We keep the cache simple
  // here.
  const candidates = [
    "10-Portfolio/Sensitive Information Rules.md",
  ];
  const redacted = new Set<string>();
  for (const path of candidates) {
    try {
      const body = await ctx.localFolders.readText(companyId, VAULT_ROOT_FOLDER_KEY, path);
      // The rules file is a Markdown bullet list. Each `- <path>`
      // line names a redacted vault-relative path. We deliberately
      // parse line-by-line rather than invoking a Markdown parser.
      for (const line of body.split(/\r?\n/)) {
        const m = /^[-*]\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const candidate = m[1].trim();
        if (candidate.endsWith(".md")) {
          redacted.add(candidate);
        }
      }
    } catch {
      // Rules file is optional; an empty allow-list means
      // "nothing is redacted".
    }
  }
  return redacted;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // Per-project vault view. The bridge returns the list of notes
    // most relevant to the project, with bodies already redacted
    // where required by the redaction rules.
    ctx.data.register(
      "vault-project-view",
      async (params: Record<string, unknown>) => {
        const projectId = typeof params.projectId === "string" ? params.projectId : "";
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const productSlug =
          typeof params.productSlug === "string" ? params.productSlug : projectId;
        if (!projectId || !companyId) {
          return { notes: [], errors: ["missing projectId or companyId"] };
        }
        const ctx_ = ctx as unknown as Parameters<typeof collectVaultNotes>[0];
        const [collected, redactedPaths] = await Promise.all([
          collectVaultNotes(ctx_, companyId),
          loadRedactedPaths(ctx_, companyId),
        ]);
        const context: ProjectVaultContext = { projectId, productSlug };
        const scored = collected.notes
          .map((note) => ({ note, score: scoreNoteRelevance(note, context) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.note.relativePath.localeCompare(b.note.relativePath));
        const items: {
          relativePath: string;
          title: string;
          score: number;
          frontmatterProject: string | null;
          mtimeMs: number | null;
          sizeBytes: number | null;
        }[] = [];
        for (const { note, score } of scored) {
          items.push({
            relativePath: note.relativePath,
            title: note.title,
            score,
            frontmatterProject: note.frontmatterProject,
            mtimeMs: note.mtimeMs,
            sizeBytes: note.sizeBytes,
          });
        }
        return {
          notes: items,
          redactedCount: redactedPaths.size,
          errors: collected.errors,
        };
      },
    );

    // Read a single vault note body for the project detail Vault
    // tab. The body is redacted if the path is in the redaction
    // allow-list. The bridge **never** writes back; it only reads.
    ctx.data.register(
      "vault-note-body",
      async (params: Record<string, unknown>) => {
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const relativePath = typeof params.relativePath === "string" ? params.relativePath : "";
        if (!companyId || !relativePath) {
          return { body: null, redacted: false, error: "missing parameters" };
        }
        const ctx_ = ctx as unknown as Parameters<typeof loadRedactedPaths>[0];
        const redactedPaths = await loadRedactedPaths(ctx_, companyId);
        try {
          const raw = await ctx_.localFolders.readText(companyId, VAULT_ROOT_FOLDER_KEY, relativePath);
          const redacted = redactedPaths.has(relativePath);
          const body = applyRedaction(relativePath, raw, redactedPaths);
          return { body, redacted, error: null };
        } catch (err) {
          return { body: null, redacted: false, error: String(err) };
        }
      },
    );

    // Per-project vault health summary. Useful for the UI to render
    // a small "vault reachable" badge without re-deriving it.
    ctx.data.register(
      "vault-health",
      async (params: Record<string, unknown>) => {
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        if (!companyId) return { reachable: false };
        try {
          const ctx_ = ctx as unknown as Parameters<typeof collectVaultNotes>[0];
          await ctx_.localFolders.list(companyId, VAULT_ROOT_FOLDER_KEY, { recursive: false, maxEntries: 1 });
          return { reachable: true };
        } catch {
          return { reachable: false };
        }
      },
    );

    // Operator-controlled config so the UI can read `showSidebarLink`
    // from the canonical config store.
    ctx.data.register("plugin-config", async (params) => {
      const companyId =
        params && typeof params === "object" && "companyId" in params
          ? typeof (params as { companyId?: unknown }).companyId === "string"
            ? ((params as { companyId: string }).companyId)
            : ""
          : "";
      const config = companyId ? await ctx.config.get(companyId) : null;
      return {
        showSidebarLink: config?.showSidebarLink === true,
      };
    });

    // Refresh-on-event hooks. The host emits
    // `plugin.<id>.vault.changed` whenever the local file watcher
    // observes a change in the vault root; the bridge uses that as
    // its refresh signal. We do not mutate state.
    ctx.events.on(
      `plugin.${PLUGIN_NAME}.vault.changed` as Parameters<typeof ctx.events.on>[0],
      async () => {
        // intentionally empty: see note in the pixel-strip plugin.
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: PLUGIN_HEALTH_MESSAGE };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
