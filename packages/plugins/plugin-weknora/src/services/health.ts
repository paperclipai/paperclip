import type { WeKnoraConfig } from "../config.js";
import { asWeknoraError, isHealthFatal, WeknoraPluginError } from "../errors.js";
import type { WeKnoraClient } from "../client/weknora-client.js";
import type { KnowledgeBaseDetail, WikiIssue, WikiStats } from "../client/types.js";

export type HealthResult = {
  status: "ok" | "degraded" | "unavailable";
  checkedAt: string;
  knowledgeBase?: KnowledgeBaseDetail | null;
  wikiStats?: WikiStats;
  lintCounts?: Record<string, number>;
  issues?: WikiIssue[];
  warnings: string[];
  error?: ReturnType<WeknoraPluginError["toJSON"]>;
};

export function unavailableHealth(checkedAt: string, error: unknown): HealthResult {
  const normalized = asWeknoraError(error);
  return {
    status: "unavailable",
    checkedAt,
    warnings: [normalized.message],
    error: normalized.toJSON(),
  };
}

export function createHealthService(client: WeKnoraClient, config: WeKnoraConfig) {
  return {
    async check(knowledgeBaseId?: string): Promise<HealthResult> {
      const checkedAt = new Date().toISOString();
      let target = knowledgeBaseId ?? config.defaultWikiKnowledgeBaseId ?? config.defaultKnowledgeBaseIds[0];
      const warnings: string[] = [];
      let knowledgeBase: KnowledgeBaseDetail | null | undefined;
      if (!target) {
        try {
          const bases = await client.listKnowledgeBases();
          target = bases.knowledgeBases[0]?.id;
          if (!target) return { status: "ok", checkedAt, knowledgeBase: null, warnings: ["No visible WeKnora knowledge bases are configured"] };
        } catch (error) {
          return unavailableHealth(checkedAt, error);
        }
      }

      const basePromise = client.knowledgeBaseDetail(target);
      const wikiPromise = client.wikiDiagnostics(target);
      const [baseResult, wikiResult] = await Promise.allSettled([basePromise, wikiPromise]);
      if (baseResult.status === "fulfilled") knowledgeBase = baseResult.value;
      else {
        const baseError = asWeknoraError(baseResult.reason);
        if (isHealthFatal(baseError)) return unavailableHealth(checkedAt, baseError);
        warnings.push(`Knowledge-base detail unavailable: ${baseError.message}`);
      }
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
      const wikiError = asWeknoraError(wikiResult.reason);
      if (isHealthFatal(wikiError)) return unavailableHealth(checkedAt, wikiError);
      warnings.push(`Wiki diagnostics unavailable: ${wikiError.message}`);
      return { status: knowledgeBase ? "degraded" : "unavailable", checkedAt, knowledgeBase, warnings };
    },
  };
}
