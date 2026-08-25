import type { WeKnoraConfig } from "../config.js";
import { asWeknoraError, WeknoraPluginError } from "../errors.js";
import type { WeKnoraClient } from "../client/weknora-client.js";

export type HealthResult = {
  status: "ok" | "degraded" | "unavailable";
  checkedAt: string;
  knowledgeBase?: Record<string, unknown> | null;
  wikiStats?: Record<string, unknown>;
  lintCounts?: Record<string, number>;
  issues?: Array<Record<string, unknown>>;
  warnings: string[];
};

export function createHealthService(client: WeKnoraClient, config: WeKnoraConfig) {
  return {
    async check(knowledgeBaseId?: string): Promise<HealthResult> {
      const checkedAt = new Date().toISOString();
      let target = knowledgeBaseId ?? config.defaultWikiKnowledgeBaseId ?? config.defaultKnowledgeBaseIds[0];
      const warnings: string[] = [];
      let knowledgeBase: Record<string, unknown> | null | undefined;
      if (!target) {
        try {
          const bases = await client.listKnowledgeBases();
          target = bases.knowledgeBases[0]?.id;
          if (!target) return { status: "ok", checkedAt, knowledgeBase: null, warnings: ["No visible WeKnora knowledge bases are configured"] };
        } catch (error) {
          const normalized = asWeknoraError(error);
          return { status: "unavailable", checkedAt, warnings: [normalized.message] };
        }
      }

      const basePromise = client.knowledgeBaseDetail(target);
      const wikiPromise = client.wikiDiagnostics(target);
      const [baseResult, wikiResult] = await Promise.allSettled([basePromise, wikiPromise]);
      if (baseResult.status === "fulfilled") knowledgeBase = baseResult.value;
      else warnings.push(`Knowledge-base detail unavailable: ${asWeknoraError(baseResult.reason).message}`);
      if (wikiResult.status === "fulfilled") {
        const diagnostics = wikiResult.value;
        warnings.push(...(diagnostics.warnings ?? []));
        return {
          status: warnings.length === 0 ? "ok" : "degraded",
          checkedAt,
          knowledgeBase,
          wikiStats: diagnostics.stats,
          lintCounts: diagnostics.lintCounts,
          issues: diagnostics.issues,
          warnings,
        };
      }
      warnings.push(`Wiki diagnostics unavailable: ${asWeknoraError(wikiResult.reason).message}`);
      return { status: knowledgeBase ? "degraded" : "unavailable", checkedAt, knowledgeBase, warnings };
    },
  };
}
