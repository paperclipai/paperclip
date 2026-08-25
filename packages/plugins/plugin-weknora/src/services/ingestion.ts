import type { WeKnoraConfig } from "../config.js";
import { WeknoraPluginError } from "../errors.js";
import type { WeKnoraClient } from "../client/weknora-client.js";

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new WeknoraPluginError("upstream", `${field} is required`, false);
  return value.trim();
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new WeknoraPluginError("upstream", "metadata must be an object", false);
  return value as Record<string, unknown>;
}

export function createIngestionService(client: WeKnoraClient, config: WeKnoraConfig) {
  function enabled() {
    if (!config.enableWriteActions) throw new WeknoraPluginError("forbidden", "WeKnora write actions are disabled by operator configuration", false, 403);
  }
  return {
    async manual(input: { knowledgeBaseId: string; title: string; content: string; metadata?: unknown }) {
      enabled();
      const title = required(input.title, "title");
      const content = required(input.content, "content");
      if (content.length > 1_000_000) throw new WeknoraPluginError("upstream", "content exceeds the 1 MB ingest limit", false);
      return client.ingestManual(required(input.knowledgeBaseId, "knowledgeBaseId"), { title: title.slice(0, 500), content, metadata: metadata(input.metadata) });
    },
    async url(input: { knowledgeBaseId: string; url: string; fileName?: string; title?: string; metadata?: unknown }) {
      enabled();
      const url = required(input.url, "url");
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch {
        throw new WeknoraPluginError("upstream", "url must be an absolute HTTP(S) URL", false);
      }
      return client.ingestUrl(required(input.knowledgeBaseId, "knowledgeBaseId"), { url: url.slice(0, 2048), fileName: input.fileName?.trim().slice(0, 255), title: input.title?.trim().slice(0, 500), metadata: metadata(input.metadata) });
    },
    async rebuildWikiLinks(knowledgeBaseId: string) {
      enabled();
      return client.rebuildWikiLinks(required(knowledgeBaseId, "knowledgeBaseId"));
    },
    async autoFixWiki(knowledgeBaseId: string) {
      enabled();
      return client.autoFixWiki(required(knowledgeBaseId, "knowledgeBaseId"));
    },
  };
}
