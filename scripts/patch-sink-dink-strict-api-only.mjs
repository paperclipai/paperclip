import { readFileSync, writeFileSync } from "node:fs";

const routePath = "server/src/routes/sink-dink-ai-campaign.ts";
let source = readFileSync(routePath, "utf8");

const marker = "STRICT_API_ONLY_NO_FALLBACK_PATCH";

if (!source.includes(marker)) {
  source = source.replace(
    'const APPROVAL_STATUS = "pending_human_approval";',
    'const APPROVAL_STATUS = "pending_human_approval";\nconst STRICT_API_ONLY_NO_FALLBACK_PATCH = true;'
  );
}

if (!source.includes("function validateStrictApiCampaignPacks")) {
  const helper = `
function validateStrictApiCampaignPacks(value: unknown, baseTopic: string, count: number): { ok: boolean; reason?: string; packs: CampaignPack[] } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "gemini_output_not_json_array", packs: [] };
  }

  const hooks = new Set<string>();
  const topics = new Set<string>();
  const packs: CampaignPack[] = [];

  for (const [index, item] of value.slice(0, count).entries()) {
    if (item === null || typeof item !== "object") {
      return { ok: false, reason: \`gemini_item_\${index + 1}_not_object\`, packs: [] };
    }

    const record = item as Record<string, unknown>;
    const script = Array.isArray(record.script)
      ? record.script
          .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
          .map(compactText)
          .slice(0, 6)
      : [];

    const title = parseString(record.title, "");
    const topic = cleanTopic(parseString(record.topic, ""), baseTopic, "");
    const hook = cleanHook(parseString(record.hook, ""), "");
    const caption = parseString(record.caption, "");
    const rawHashtags = Array.isArray(record.hashtags)
      ? record.hashtags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const hashtags = ensureHashtags(rawHashtags, []);
    const visualStyle = parseString(record.visualStyle, "");

    if (!title || topic.length < 8 || hook.length < 12 || script.length < 4 || caption.length < 20 || hashtags.length < 3 || !visualStyle) {
      return { ok: false, reason: \`gemini_item_\${index + 1}_failed_required_fields\`, packs: [] };
    }

    const topicKey = topic.toLowerCase();
    const hookKey = hook.toLowerCase();
    if (topics.has(topicKey)) {
      return { ok: false, reason: \`gemini_item_\${index + 1}_duplicate_topic\`, packs: [] };
    }
    if (hooks.has(hookKey)) {
      return { ok: false, reason: \`gemini_item_\${index + 1}_duplicate_hook\`, packs: [] };
    }

    topics.add(topicKey);
    hooks.add(hookKey);

    const pack: CampaignPack = {
      title,
      topic,
      hook,
      script,
      caption,
      hashtags,
      visualStyle,
      approvalStatus: APPROVAL_STATUS,
    };

    if (containsBlockedLanguage(pack)) {
      return { ok: false, reason: \`gemini_item_\${index + 1}_blocked_language\`, packs: [] };
    }

    packs.push(pack);
  }

  if (packs.length !== count) {
    return { ok: false, reason: \`gemini_expected_\${count}_items_got_\${packs.length}\`, packs: [] };
  }

  return { ok: true, packs };
}
`;

  source = source.replace(
    "function absoluteWorkerFileUrl(workerUrl: string, value: unknown): string | null {",
    `${helper}\nfunction absoluteWorkerFileUrl(workerUrl: string, value: unknown): string | null {`
  );
}

source = source.replace(
  `async function generateCampaignPacks(input: {
  topic: string;
  count: number;
  tone: string;
}): Promise<{ ok: boolean; provider: string; model?: string; fallbackUsed: boolean; reason?: string; packs: CampaignPack[] }> {
  const fallback = fallbackCampaignPacks(input.topic, input.count, input.tone);
  const apiKey = getGeminiApiKey();
  if (!apiKey || process.env.PAPERCLIP_GEMINI_DIRECT_API !== "true" || process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE !== "true") {
    return { ok: true, provider: "fallback", fallbackUsed: true, reason: "gemini_not_enabled", packs: fallback };
  }
`,
  `async function generateCampaignPacks(input: {
  topic: string;
  count: number;
  tone: string;
}): Promise<{ ok: boolean; provider: string; model?: string; fallbackUsed: boolean; reason?: string; packs: CampaignPack[] }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { ok: false, provider: "gemini", fallbackUsed: false, reason: "gemini_api_key_missing", packs: [] };
  }
  if (process.env.PAPERCLIP_GEMINI_DIRECT_API !== "true" || process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE !== "true") {
    return { ok: false, provider: "gemini", fallbackUsed: false, reason: "gemini_direct_execution_not_enabled", packs: [] };
  }
`
);

source = source.replace(
  '      return { ok: true, provider: "gemini", model, fallbackUsed: true, reason: `gemini_http_${response.status}`, packs: fallback };',
  '      return { ok: false, provider: "gemini", model, fallbackUsed: false, reason: `gemini_http_${response.status}:${raw.slice(0, 240)}`, packs: [] };'
);

source = source.replace(
  `    const packs = validateCampaignPacks(extractJsonArray(output), fallback, input.topic, input.count);
    return { ok: true, provider: "gemini", model, fallbackUsed: false, packs };`,
  `    const strict = validateStrictApiCampaignPacks(extractJsonArray(output), input.topic, input.count);
    if (!strict.ok) {
      return { ok: false, provider: "gemini", model, fallbackUsed: false, reason: strict.reason ?? "gemini_output_failed_strict_validation", packs: [] };
    }
    return { ok: true, provider: "gemini", model, fallbackUsed: false, packs: strict.packs };`
);

source = source.replace(
  `    return {
      ok: true,
      provider: "gemini",
      model,
      fallbackUsed: true,
      reason: error instanceof Error ? error.message : "gemini_failed",
      packs: fallback,
    };`,
  `    return {
      ok: false,
      provider: "gemini",
      model,
      fallbackUsed: false,
      reason: error instanceof Error ? error.message : "gemini_failed",
      packs: [],
    };`
);

if (!source.includes('strictApiOnly: STRICT_API_ONLY_NO_FALLBACK_PATCH')) {
  source = source.replace(
    '      geminiExecutionAllowed: process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE === "true",',
    '      geminiExecutionAllowed: process.env.PAPERCLIP_GEMINI_DIRECT_EXECUTE === "true",\n      strictApiOnly: STRICT_API_ONLY_NO_FALLBACK_PATCH,\n      fallbackAllowed: false,'
  );
}

if (!source.includes('event_type: "ai_campaign_blocked_no_fallback"')) {
  source = source.replace(
    `    const campaign = await generateCampaignPacks({ topic, count, tone });
    const results: Array<Record<string, unknown>> = [];`,
    `    const campaign = await generateCampaignPacks({ topic, count, tone });
    if (!campaign.ok || campaign.packs.length < count) {
      await insertSupabaseRows("sink_dink_audit_log", [{
        event_type: "ai_campaign_blocked_no_fallback",
        job_id: batchId,
        actor: "paperclip-ai-campaign",
        details: {
          batchId,
          requestedTopic: topic,
          requestedCount: count,
          tone,
          durationSec,
          aiProvider: campaign.provider,
          model: campaign.model,
          fallbackUsed: false,
          fallbackAllowed: false,
          strictApiOnly: true,
          reason: campaign.reason,
          agentsRunMode: "paused_human_approval",
          humanApprovalRequired: true,
          publishingBlocked: true,
        },
      }]);

      res.status(502).json({
        ok: false,
        service: "sink-dink-ai-campaign",
        mode: "ai-campaign-create-v3-strict-api-only",
        batchId,
        error: "AI model API failed or returned invalid content. Fallback content is disabled.",
        ai: {
          provider: campaign.provider,
          model: campaign.model,
          fallbackUsed: false,
          fallbackAllowed: false,
          strictApiOnly: true,
          reason: campaign.reason,
        },
        count,
        successCount: 0,
        failedCount: count,
        averageQaScore: 0,
        results: [],
        agentsRunMode: "paused_human_approval",
        humanApprovalRequired: true,
        publishingBlocked: true,
      });
      return;
    }

    const results: Array<Record<string, unknown>> = [];`
  );
}

source = source.replace(
  '      mode: "ai-campaign-create-v2-quality-gated",',
  '      mode: "ai-campaign-create-v3-strict-api-only",'
);

writeFileSync(routePath, source, "utf8");
console.log("Patched SINK DINK AI campaign route: strict API-only, no fallback content.");

const appPath = "server/src/app.ts";
let appSource = readFileSync(appPath, "utf8");
const artifactImportLine = 'import { sinkDinkArtifactRoutes } from "./routes/sink-dink-artifacts.js";';
const artifactReviewImportLine = 'import { sinkDinkArtifactReviewRoutes } from "./routes/sink-dink-artifact-review.js";';
if (!appSource.includes(artifactReviewImportLine)) {
  if (!appSource.includes(artifactImportLine)) {
    throw new Error("Expected artifact route import not found before review mount");
  }
  appSource = appSource.replace(artifactImportLine, `${artifactImportLine}\n${artifactReviewImportLine}`);
}
const artifactMountLine = "  api.use(sinkDinkArtifactRoutes());";
const artifactReviewMountLine = "  api.use(sinkDinkArtifactReviewRoutes());";
if (!appSource.includes(artifactReviewMountLine)) {
  if (!appSource.includes(artifactMountLine)) {
    throw new Error("Expected artifact route mount not found before review mount");
  }
  appSource = appSource.replace(artifactMountLine, `${artifactMountLine}\n${artifactReviewMountLine}`);
}
writeFileSync(appPath, appSource, "utf8");
console.log("Mounted SINK DINK artifact review route in app.ts");
