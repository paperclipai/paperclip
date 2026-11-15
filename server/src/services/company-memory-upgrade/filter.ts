/**
 * Orchestrator service for memory upgrade quality filter (TECH-8572).
 *
 * ARCHITECTURAL CONTRACT:
 * - Two-stage classification: deterministic prefilter (Stage 1) then LLM classifier (Stage 2).
 * - Preserves exact input record order and JSONL key ordering.
 * - Budget guard: serialized request body bytes preflight check + in-flight reserve/settle guard.
 * - Concurrency: 1..16 bounded concurrency (default 4).
 * - Rate limiting: RPM/TPM token buckets with system clock/sleeper defaults.
 * - Terminal error promptly aborts in-flight calls via AbortController; no partial output.
 * - Atomic directory rename to destination with COMPLETE marker written last.
 */

import { createDb, type Db } from "@paperclipai/db";
import { validateDatabaseUrl } from "./census.js";
import { createSystemClock, createSystemSleeper, type MonotonicClock, type Sleeper } from "./clock.js";
import {
  ceilTokenCostNanodollars,
  priceUsdPerMillionToNanodollars,
  usdToNanodollars,
} from "./cost.js";
import type { ExportJsonlRecord } from "./export-contract.js";
import {
  type FilterClassifierClient,
  nanodollarsToUsdNumber,
  OpenAiFilterClassifierClient,
  projectBatchWorstCaseCostNanodollars,
  projectRecordWorstCaseCostNanodollars,
} from "./filter-classifier.js";
import {
  FILTER_ID,
  FILTER_MODEL,
  FILTER_PROMPT_SHA256,
  FILTER_VERSION,
  type FilterAuditRecord,
  type FilterMetadata,
  type FilterOptions,
  type FilterReport,
} from "./filter-contract.js";
import {
  readAndValidateInputJsonl,
  readAndValidateInputManifest,
  readKeepImportKeysFile,
  writeFilterOutputFiles,
} from "./filter-paths.js";
import { formatFilterTextReport } from "./filter-report.js";
import { applyDeterministicFilter } from "./filter-rules.js";
import { resolveCompanyOpenAiKey } from "./openai-key.js";
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export { formatFilterTextReport };

export interface FilterDependencies {
  classifierClient?: FilterClassifierClient;
  cpDb?: Db;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  rateLimiter?: RateLimiter;
  clock?: MonotonicClock;
  sleeper?: Sleeper;
  chatInputUsdPerMillion?: number;
  chatOutputUsdPerMillion?: number;
  now?: Date;
  _internalFailureHookAfterJsonl?: () => void;
  _internalSkipPreflightBudgetCheck?: boolean;
}

export async function runFilter(
  options: FilterOptions,
  deps: FilterDependencies = {},
): Promise<FilterReport> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? createSystemClock();
  const sleeper = deps.sleeper ?? createSystemSleeper();

  // 1. Manifest validation
  const manifest = readAndValidateInputManifest(options.manifestPath);

  if (options.companyId && options.companyId.trim().toLowerCase() !== manifest.company_id) {
    throw new CompanyMemoryUpgradeError(
      "Flag --company does not match manifest company_id.",
      "INVALID_ARGUMENT",
    );
  }

  if (options.agentId && options.agentId.trim().toLowerCase() !== manifest.agent_id) {
    throw new CompanyMemoryUpgradeError(
      "Flag --agent does not match manifest agent_id.",
      "INVALID_ARGUMENT",
    );
  }

  if (options.upgradeId && options.upgradeId.trim().toLowerCase() !== manifest.upgrade_id) {
    throw new CompanyMemoryUpgradeError(
      "Flag --upgrade-id does not match manifest upgrade_id.",
      "INVALID_ARGUMENT",
    );
  }

  const canonicalConfirm = options.confirm ? options.confirm.trim().toLowerCase() : null;
  if (canonicalConfirm && canonicalConfirm !== manifest.company_id) {
    throw new CompanyMemoryUpgradeError(
      "Flag --confirm <uuid> must strictly match --company <uuid>.",
      "INVALID_ARGUMENT",
    );
  }

  if (canonicalConfirm && !options.outputDir) {
    throw new CompanyMemoryUpgradeError(
      "Flag --output-dir is required when --confirm is supplied.",
      "INVALID_ARGUMENT",
    );
  }

  // 2. Strict JSONL verification
  const { records } = readAndValidateInputJsonl(options.jsonlPath, manifest);

  // 3. Keep import keys override list
  const keepKeys = options.keepImportKeysPath
    ? readKeepImportKeysFile(options.keepImportKeysPath)
    : new Set<string>();

  const isDryRun = Boolean(options.isDryRun) || !canonicalConfirm;

  // Concurrency & rate-limit validation
  const rawConcurrency = options.concurrency ?? 4;
  if (
    !Number.isInteger(rawConcurrency) ||
    rawConcurrency < 1 ||
    rawConcurrency > 16
  ) {
    throw new CompanyMemoryUpgradeError(
      "Invalid --concurrency. Must be an integer between 1 and 16.",
      "INVALID_ARGUMENT",
    );
  }
  const concurrency = rawConcurrency;

  const chatRpm = options.chatRpm ?? 500;
  const chatTpm = options.chatTpm ?? 200_000;

  // Pricing & budget configuration
  const chatInputUsd = deps.chatInputUsdPerMillion ?? 0.15;
  const chatOutputUsd = deps.chatOutputUsdPerMillion ?? 0.60;
  const chatInputNano = priceUsdPerMillionToNanodollars(chatInputUsd, "chatInputUsdPerMillion");
  const chatOutputNano = priceUsdPerMillionToNanodollars(chatOutputUsd, "chatOutputUsdPerMillion");

  const maxCostUsd = options.maxCostUsd ?? 2;
  const budgetNano = usdToNanodollars(maxCostUsd, "max-cost-usd", "floor");

  // 4. Resolve key if not provided directly via client
  let classifierClient = deps.classifierClient;
  let resolvedKey: string | null = null;

  if (!classifierClient) {
    if (options.openaiKeyFile) {
      resolvedKey = await resolveCompanyOpenAiKey({
        controlPlaneDb: null as any,
        companyId: manifest.company_id,
        keyFilePath: options.openaiKeyFile,
        repoRoot: deps.repoRoot,
      });
    } else {
      const cpUrl =
        options.controlPlaneDatabaseUrl ?? env.CONTROL_PLANE_DATABASE_URL ?? null;
      if (cpUrl) {
        validateDatabaseUrl(cpUrl, env, { allowProd: options.allowProd });
        const cpDb = deps.cpDb ?? createDb(cpUrl);
        try {
          resolvedKey = await resolveCompanyOpenAiKey({
            controlPlaneDb: cpDb,
            companyId: manifest.company_id,
            repoRoot: deps.repoRoot,
          });
        } catch (err) {
          if (!isDryRun) throw err;
        }
      }
    }

    if (!resolvedKey && !isDryRun) {
      throw new CompanyMemoryUpgradeError(
        "OpenAI API key required for non-dry-run execution.",
        "FILTER_KEY_REQUIRED",
      );
    }

    if (resolvedKey) {
      const rateLimiter =
        deps.rateLimiter ??
        createRateLimiter({
          rpm: chatRpm,
          tpm: chatTpm,
          concurrency,
          maxConcurrencyCap: 16,
          clock,
          sleeper,
        });

      classifierClient = new OpenAiFilterClassifierClient({
        apiKey: resolvedKey,
        model: options.model ?? FILTER_MODEL,
        rateLimiter,
        clock,
        sleeper,
      });
    }
  }

  // 5. Stage 1: Deterministic filtering & override list
  interface IndexedDecision {
    index: number;
    record: ExportJsonlRecord;
    decision: "keep" | "drop";
    stage: "override" | "deterministic" | "classifier";
    reason: string;
  }

  const decisions: IndexedDecision[] = [];
  const needsClassification: Array<{ index: number; record: ExportJsonlRecord }> = [];
  const ruleCounts: Record<string, number> = {};
  const classifiedReasons: Record<string, number> = {};

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (keepKeys.has(record.import_key.toLowerCase())) {
      decisions.push({
        index: i,
        record,
        decision: "keep",
        stage: "override",
        reason: "manual_override",
      });
      continue;
    }

    const rule = applyDeterministicFilter(record);
    if (rule) {
      ruleCounts[rule.id] = (ruleCounts[rule.id] ?? 0) + 1;
      decisions.push({
        index: i,
        record,
        decision: "drop",
        stage: "deterministic",
        reason: rule.id,
      });
      continue;
    }

    needsClassification.push({ index: i, record });
  }

  // Bytes-based conservative worst-case cost projection
  const projectedNano = projectBatchWorstCaseCostNanodollars(
    needsClassification.map((n) => n.record.text),
    options.model ?? FILTER_MODEL,
    chatInputNano,
    chatOutputNano,
  );
  const projectedCostUsd = nanodollarsToUsdNumber(projectedNano);

  // If dry-run without key, stop before model calls
  if (isDryRun && !classifierClient) {
    const droppedDeterministicCount = decisions.filter((d) => d.decision === "drop").length;
    const keptCount = decisions.filter((d) => d.decision === "keep").length;

    return {
      isDryRun: true,
      companyId: manifest.company_id,
      agentId: manifest.agent_id,
      upgradeId: manifest.upgrade_id,
      inputRecordCount: records.length,
      inputJsonlSha256: manifest.jsonl_sha256,
      keptCount,
      droppedDeterministicCount,
      droppedClassifiedCount: 0,
      ruleCounts,
      classifiedReasons,
      projectedCostUsd,
      actualCostUsd: 0,
      outputJsonlPath: null,
      outputManifestPath: null,
      outputJsonlSha256: null,
      auditTxtPath: null,
      auditJsonPath: null,
      metadataPath: null,
    };
  }

  // Preflight budget guard
  if (!deps._internalSkipPreflightBudgetCheck && projectedNano > budgetNano) {
    throw new CompanyMemoryUpgradeError(
      `Estimated or actual filter cost exceeds --max-cost-usd budget. Projected: $${projectedCostUsd.toFixed(4)}, Budget: $${maxCostUsd}.`,
      "FILTER_BUDGET_EXCEEDED",
    );
  }

  // Stage 2: LLM classification with reserve/settle budget tracking and prompt abort
  let actualSpentNano = 0n;
  let reservedInFlightNano = 0n;
  let nextQueueIdx = 0;
  const abortController = new AbortController();
  let fatalError: Error | null = null;

  async function worker(): Promise<void> {
    while (true) {
      if (abortController.signal.aborted || fatalError) {
        break;
      }

      let currentItem: { index: number; record: ExportJsonlRecord } | undefined;
      let worstCaseCostForCall = 0n;

      // Atomic reservation under synchronous block
      if (nextQueueIdx < needsClassification.length) {
        currentItem = needsClassification[nextQueueIdx++];
        worstCaseCostForCall = projectRecordWorstCaseCostNanodollars(
          currentItem.record.text,
          options.model ?? FILTER_MODEL,
          chatInputNano,
          chatOutputNano,
        );

        if (actualSpentNano + reservedInFlightNano + worstCaseCostForCall > budgetNano) {
          const err = new CompanyMemoryUpgradeError(
            `Estimated or actual filter cost exceeds --max-cost-usd budget. In-flight + actual: $${nanodollarsToUsdNumber(actualSpentNano + reservedInFlightNano + worstCaseCostForCall).toFixed(4)}, Budget: $${maxCostUsd}.`,
            "FILTER_BUDGET_EXCEEDED",
          );
          fatalError = err;
          abortController.abort();
          throw err;
        }

        reservedInFlightNano += worstCaseCostForCall;
      } else {
        break;
      }

      try {
        const res = await classifierClient!.classify(
          currentItem.record.text,
          currentItem.record.import_key,
          { signal: abortController.signal },
        );

        const callCost =
          ceilTokenCostNanodollars(res.inputTokens, chatInputNano) +
          ceilTokenCostNanodollars(res.outputTokens, chatOutputNano);

        reservedInFlightNano -= worstCaseCostForCall;
        actualSpentNano += callCost;

        if (actualSpentNano > budgetNano) {
          const err = new CompanyMemoryUpgradeError(
            `Estimated or actual filter cost exceeds --max-cost-usd budget. Actual spend: $${nanodollarsToUsdNumber(actualSpentNano).toFixed(4)}, Budget: $${maxCostUsd}.`,
            "FILTER_BUDGET_EXCEEDED",
          );
          fatalError = err;
          abortController.abort();
          throw err;
        }

        classifiedReasons[res.reason] = (classifiedReasons[res.reason] ?? 0) + 1;
        decisions.push({
          index: currentItem.index,
          record: currentItem.record,
          decision: res.decision,
          stage: "classifier",
          reason: res.reason,
        });
      } catch (err: any) {
        reservedInFlightNano -= worstCaseCostForCall;
        if (!fatalError) {
          fatalError = err;
          abortController.abort();
        }
        throw err;
      }
    }
  }

  const workerCount = Math.min(concurrency, needsClassification.length || 1);
  const workers = Array.from({ length: workerCount }, () => worker());

  try {
    await Promise.all(workers);
  } catch (err) {
    throw fatalError ?? err;
  }

  // Preserve exact input order
  decisions.sort((a, b) => a.index - b.index);

  const keptRecords = decisions
    .filter((d) => d.decision === "keep")
    .map((d) => d.record);

  const auditRecords: FilterAuditRecord[] = decisions.map((d) => ({
    import_key: d.record.import_key,
    decision: d.decision,
    stage: d.stage,
    reason: d.reason,
  }));

  const droppedDeterministicCount = decisions.filter(
    (d) => d.stage === "deterministic" && d.decision === "drop",
  ).length;
  const droppedClassifiedCount = decisions.filter(
    (d) => d.stage === "classifier" && d.decision === "drop",
  ).length;

  const actualCostUsd = nanodollarsToUsdNumber(actualSpentNano);

  const generatedAt = deps.now ? deps.now.toISOString() : new Date().toISOString();
  const filterMetadata: FilterMetadata = {
    filter_id: FILTER_ID,
    filter_version: FILTER_VERSION,
    prompt_sha256: FILTER_PROMPT_SHA256,
    model: options.model ?? FILTER_MODEL,
    kept: keptRecords.length,
    dropped_deterministic: droppedDeterministicCount,
    dropped_classified: droppedClassifiedCount,
    rule_counts: ruleCounts,
    classified_reasons: classifiedReasons,
    generated_at: generatedAt,
    input_jsonl_sha256: manifest.jsonl_sha256,
    input_record_count: records.length,
  };

  let outputPaths = {
    outputJsonlPath: null as string | null,
    outputManifestPath: null as string | null,
    outputJsonlSha256: null as string | null,
    auditTxtPath: null as string | null,
    auditJsonPath: null as string | null,
    metadataPath: null as string | null,
  };

  if (!isDryRun) {
    const written = await writeFilterOutputFiles({
      outputDir: options.outputDir,
      repoRoot: deps.repoRoot,
      inputJsonlPath: options.jsonlPath,
      inputManifestPath: options.manifestPath,
      originalManifest: manifest,
      keptRecords,
      auditRecords,
      filterMetadata,
      _internalFailureHookAfterJsonl: deps._internalFailureHookAfterJsonl,
    });
    outputPaths = written;
  }

  return {
    isDryRun,
    companyId: manifest.company_id,
    agentId: manifest.agent_id,
    upgradeId: manifest.upgrade_id,
    inputRecordCount: records.length,
    inputJsonlSha256: manifest.jsonl_sha256,
    keptCount: keptRecords.length,
    droppedDeterministicCount,
    droppedClassifiedCount,
    ruleCounts,
    classifiedReasons,
    projectedCostUsd,
    actualCostUsd,
    ...outputPaths,
  };
}
