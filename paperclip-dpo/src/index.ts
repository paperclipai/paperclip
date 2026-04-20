import { randomUUID } from "node:crypto";
import { detectPii } from "./pii-detector.js";
import { classifyEntities, DpoUnavailableError, type ClassifierConfig } from "./entity-classifier.js";
import { anonymizeText } from "./anonymizer.js";
import { deanonymizeText } from "./deanonymizer.js";
import { MappingStore } from "./mapping-store.js";
import { AuditLog, hashPrompt } from "./audit-log.js";
import { loadDefaultRules, type Rules } from "./rules.js";
import type {
  AnonymizeRequest,
  AnonymizeResponse,
  AnonymizeResult,
  AnonymizeBlocked,
  DeanonymizeRequest,
  DeanonymizeResult,
  Finding,
  Confidence,
} from "./types.js";

export type { AnonymizeRequest, AnonymizeResponse, DeanonymizeRequest, DeanonymizeResult } from "./types.js";
export { DpoUnavailableError } from "./entity-classifier.js";

export interface DpoOptions {
  mappingDbPath: string;
  mappingKey: Buffer;
  auditDir: string;
  classifier: ClassifierConfig;
  rules?: Rules;
}

export interface Dpo {
  anonymize(req: AnonymizeRequest): Promise<AnonymizeResponse>;
  deanonymize(req: DeanonymizeRequest): DeanonymizeResult;
  close(): void;
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function createDpo(opts: DpoOptions): Dpo {
  const rules = opts.rules ?? loadDefaultRules();
  const store = new MappingStore({ path: opts.mappingDbPath, key: opts.mappingKey });
  const audit = new AuditLog({ dir: opts.auditDir });

  return {
    async anonymize(req: AnonymizeRequest): Promise<AnonymizeResponse> {
      const tenantId = req.tenantId ?? rules.tenant;
      const ts = new Date().toISOString();
      const promptHash = hashPrompt(req.text);

      let llmFindings: Finding[] = [];
      try {
        llmFindings = await classifyEntities(req.text, opts.classifier);
      } catch (err) {
        if (err instanceof DpoUnavailableError) {
          const blocked: AnonymizeBlocked = { blocked: true, reason: "dpo_unavailable" };
          audit.write({
            ts, agent: req.agent, targetLlm: req.targetLlm, tenantId,
            promptHash, findings: {}, blocked: true, blockedReason: "dpo_unavailable",
          });
          return blocked;
        }
        throw err;
      }

      if (rules.block.art_9_categories) {
        const blockRank = CONF_RANK[rules.confidenceThreshold.block];
        const art9Hit = llmFindings.find(
          (f) => f.type === "ART_9" && CONF_RANK[f.confidence] >= blockRank,
        );
        if (art9Hit) {
          const blocked: AnonymizeBlocked = { blocked: true, reason: "art_9_data_detected" };
          audit.write({
            ts, agent: req.agent, targetLlm: req.targetLlm, tenantId,
            promptHash, findings: { ART_9: 1 }, blocked: true, blockedReason: "art_9_data_detected",
          });
          return blocked;
        }
      }

      const piiFindings = detectPii(req.text);
      const all = [...piiFindings, ...llmFindings];

      const anonRank = CONF_RANK[rules.confidenceThreshold.anonymize];
      const filtered = all.filter(
        (f) => f.source === "regex" || CONF_RANK[f.confidence] >= anonRank,
      );

      const { text: anonText, mappings } = anonymizeText(req.text, filtered);
      const mappingId = randomUUID();
      store.write(mappingId, tenantId, mappings, rules.mapping.ttlSeconds);

      const counts: Record<string, number> = {};
      const confByType: Record<string, Confidence> = {};
      for (const f of filtered) {
        counts[f.type] = (counts[f.type] ?? 0) + 1;
        const cur = confByType[f.type];
        if (!cur || CONF_RANK[f.confidence] > CONF_RANK[cur]) confByType[f.type] = f.confidence;
      }

      audit.write({
        ts, agent: req.agent, targetLlm: req.targetLlm, tenantId,
        promptHash, findings: counts, blocked: false,
      });

      const result: AnonymizeResult = {
        mappingId,
        anonymizedText: anonText,
        findings: Object.entries(counts).map(([type, count]) => ({
          type: type as AnonymizeResult["findings"][number]["type"],
          count,
          confidence: confByType[type],
        })),
        warnings: [],
      };
      return result;
    },

    deanonymize(req: DeanonymizeRequest): DeanonymizeResult {
      const mappings = store.read(req.mappingId);
      return { text: deanonymizeText(req.text, mappings) };
    },

    close(): void {
      store.close();
    },
  };
}

export { safeExternalLlm } from "./safe-external-llm.js";
export type { SafeExternalLlmOptions, SafeExternalLlmResult } from "./safe-external-llm.js";
