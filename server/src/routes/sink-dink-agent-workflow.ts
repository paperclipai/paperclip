import { Router, type Request } from "express";

const DEFAULT_TOPIC = "SINK DINK India me family pressure aur personal freedom";
const DEFAULT_TONE = "smart Hinglish, relatable, emotionally sharp, Instagram top-page style";
const APPROVAL_STATUS = "pending_human_approval";

function normalizeBaseUrl(rawUrl: string | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function originOnly(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function resolveSelfOrigin(req: Request): string {
  const configured = normalizeBaseUrl(process.env.PAPERCLIP_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_BASE_URL);
  const configuredOrigin = originOnly(configured);
  if (configuredOrigin) return configuredOrigin;

  const protocol = req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim() || req.protocol || "https";
  const host = req.get("host") || "localhost";
  return `${protocol}://${host}`;
}

function resolveTrustedBrowserOrigin(req: Request, fallbackOrigin: string): string {
  const inboundOrigin = originOnly(req.header("origin") ?? null);
  if (inboundOrigin) return inboundOrigin;

  const inboundRefererOrigin = originOnly(req.header("referer") ?? null);
  if (inboundRefererOrigin) return inboundRefererOrigin;

  return fallbackOrigin;
}

async function insertSupabaseRows(table: string, rows: Array<Record<string, unknown>>): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const supabaseUrl = normalizeBaseUrl(process.env.SUPABASE_URL);
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return { ok: true, skipped: true };

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (response.ok) return { ok: true };
  return { ok: false, error: await response.text() };
}

function buildTrace(input: {
  topic: string;
  count: number;
  campaignOk: boolean;
  successCount: number;
  failedCount: number;
  averageQaScore: number;
}) {
  return [
    {
      agent: "CEO",
      status: "completed",
      summary: `Command accepted. Campaign goal set for ${input.count} SINK/DINK India reel outputs.`,
    },
    {
      agent: "Research",
      status: "completed",
      summary: "Audience angle locked around Indian couple pressure, personal freedom, financial peace, and respectful boundaries.",
    },
    {
      agent: "Strategy",
      status: "completed",
      summary: `Campaign topic context: ${input.topic}`,
    },
    {
      agent: "Content",
      status: "completed",
      summary: "Hooks, scripts, captions, hashtags, and visual style requested through the existing AI campaign brain.",
    },
    {
      agent: "Media",
      status: input.campaignOk ? "completed" : "needs_review",
      summary: `Media worker returned ${input.successCount} successful item(s) and ${input.failedCount} failed item(s).`,
    },
    {
      agent: "QA",
      status: input.averageQaScore >= 90 && input.failedCount === 0 ? "completed" : "manual_review_required",
      summary: `Average QA score: ${input.averageQaScore}. Publishing remains blocked.`,
    },
    {
      agent: "ApprovalGate",
      status: APPROVAL_STATUS,
      summary: "All outputs remain pending human approval. No auto-publishing, no auto-spend, no uncontrolled loop.",
    },
  ];
}

export function sinkDinkAgentWorkflowRoutes() {
  const router = Router();

  router.get("/sink-dink/agent-workflow/status", (_req, res) => {
    res.json({
      ok: true,
      service: "sink-dink-controlled-agent-workflow",
      mode: "controlled_human_approval",
      targetRoute: "/api/sink-dink/agent-workflow/start-day",
      wrappedRoute: "/api/sink-dink/ai-campaign/create",
      agentsRunMode: "paused_human_approval",
      humanApprovalRequired: true,
      publishingBlocked: true,
      supabaseConfigured: Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      workerUrlConfigured: Boolean(process.env.MEDIA_WORKER_URL?.trim() || process.env.SINK_DINK_MEDIA_WORKER_URL?.trim()),
    });
  });

  router.post("/sink-dink/agent-workflow/start-day", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const command = parseString(body.command, "CEO, aaj ka kaam start kro");
    const topic = parseString(body.topic, DEFAULT_TOPIC);
    const count = Math.min(10, Math.max(1, Math.floor(parsePositiveNumber(body.count, 5))));
    const tone = parseString(body.tone, DEFAULT_TONE);
    const durationSec = parsePositiveNumber(body.durationSec, 25);
    const workflowId = `workflow-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

    try {
      const origin = resolveSelfOrigin(req);
      const trustedBrowserOrigin = resolveTrustedBrowserOrigin(req, origin);
      const wrappedRoute = `${origin}/api/sink-dink/ai-campaign/create`;
      const campaignResponse = await fetch(wrappedRoute, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: trustedBrowserOrigin,
          Referer: `${trustedBrowserOrigin}/NSD/dashboard`,
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: JSON.stringify({ topic, count, tone, durationSec }),
      });

      const campaign = await campaignResponse.json().catch(async () => ({
        ok: false,
        raw: await campaignResponse.text().catch(() => ""),
      })) as Record<string, unknown>;

      const results = Array.isArray(campaign.results) ? campaign.results : [];
      const successCount = typeof campaign.successCount === "number" ? campaign.successCount : results.filter((item) => (item as Record<string, unknown>).ok === true).length;
      const failedCount = typeof campaign.failedCount === "number" ? campaign.failedCount : results.length - successCount;
      const averageQaScore = typeof campaign.averageQaScore === "number" ? campaign.averageQaScore : 0;
      const campaignOk = campaignResponse.ok && campaign.ok !== false;
      const workflowTrace = buildTrace({ topic, count, campaignOk, successCount, failedCount, averageQaScore });

      const supabaseAudit = await insertSupabaseRows("sink_dink_audit_log", [{
        event_type: "controlled_agent_workflow_start_day",
        job_id: workflowId,
        actor: "paperclip-controlled-agent-workflow",
        details: {
          workflowId,
          command,
          topic,
          count,
          tone,
          durationSec,
          wrappedRoute,
          trustedBrowserOrigin,
          campaignBatchId: campaign.batchId ?? null,
          campaignHttpStatus: campaignResponse.status,
          successCount,
          failedCount,
          averageQaScore,
          agentsRunMode: "paused_human_approval",
          approvalStatus: APPROVAL_STATUS,
          humanApprovalRequired: true,
          publishingBlocked: true,
        },
      }]);

      res.status(campaignResponse.ok ? 200 : 502).json({
        ok: campaignOk,
        service: "sink-dink-controlled-agent-workflow",
        mode: "controlled_human_approval",
        workflowId,
        command,
        agentsRunMode: "paused_human_approval",
        humanApprovalRequired: true,
        publishingBlocked: true,
        approvalStatus: APPROVAL_STATUS,
        workflowTrace,
        campaign,
        diagnostics: {
          resolvedOrigin: origin,
          trustedBrowserOrigin,
          wrappedRoute,
          campaignHttpStatus: campaignResponse.status,
        },
        supabase: { audit: supabaseAudit },
      });
    } catch (error) {
      const workflowTrace = buildTrace({ topic, count, campaignOk: false, successCount: 0, failedCount: count, averageQaScore: 0 });
      res.status(502).json({
        ok: false,
        service: "sink-dink-controlled-agent-workflow",
        errorType: "controlled_agent_workflow_failed",
        safeMessage: error instanceof Error ? error.message : "Unknown workflow error.",
        workflowId,
        agentsRunMode: "paused_human_approval",
        humanApprovalRequired: true,
        publishingBlocked: true,
        approvalStatus: APPROVAL_STATUS,
        workflowTrace,
      });
    }
  });

  return router;
}
