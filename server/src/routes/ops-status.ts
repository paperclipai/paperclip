import { Router } from "express";

export type OpsCheckStatus = "ok" | "warning" | "error" | "unknown";

export interface OpsStatusCheck {
  id: string;
  label: string;
  status: OpsCheckStatus;
  summary: string;
  detail?: string;
  updatedAt: string;
}

export interface OpsStatusResponse {
  status: OpsCheckStatus;
  checks: OpsStatusCheck[];
}

const DEFAULT_PAPERCLIP_URL = "https://paperclip-vqnh.onrender.com";
const DEFAULT_RENDER_SERVICE_ID = "srv-d81prrl7vvec738n6rvg";
const DEFAULT_EXPECTED_REPO = "https://github.com/TheThomais/paperclip";
const DEFAULT_EXPECTED_BRANCH = "master";
const DEFAULT_THOMAS_BRIDGE_URL = "http://127.0.0.1:9119/health";
const CURRENT_UI_MARKERS = ["Write an article", "Article Work", "Article Creation"];

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(statuses: OpsCheckStatus[]): OpsCheckStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("unknown")) return "unknown";
  return "ok";
}

async function fetchText(url: string, init?: RequestInit, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  const { response, text } = await fetchText(url, init, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(text) as T;
}

function renderHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function sanitizeOpsDetail(value: unknown) {
  if (!(value instanceof Error)) return "The check did not complete.";
  return value.message
    .replace(/https?:\/\/[^\s)]+/gi, "[url-redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(api[-_]?key|token|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 240);
}

async function checkRenderService(): Promise<OpsStatusCheck> {
  const updatedAt = nowIso();
  const apiKey = process.env.RENDER_API_KEY?.trim();
  if (!apiKey) {
    return {
      id: "render-paperclip",
      label: "Paperclip deploy",
      status: "unknown",
      summary: "Render deploy checks are not connected here yet.",
      detail: "Set RENDER_API_KEY on this service to verify repo, branch, and deploy freshness from inside Paperclip.",
      updatedAt,
    };
  }

  const serviceId = process.env.PAPERCLIP_RENDER_SERVICE_ID?.trim() || DEFAULT_RENDER_SERVICE_ID;
  const expectedRepo = process.env.PAPERCLIP_EXPECTED_RENDER_REPO?.trim() || DEFAULT_EXPECTED_REPO;
  const expectedBranch = process.env.PAPERCLIP_EXPECTED_RENDER_BRANCH?.trim() || DEFAULT_EXPECTED_BRANCH;
  const service = await fetchJson<{
    repo?: string;
    branch?: string;
    dashboardUrl?: string;
  }>(`https://api.render.com/v1/services/${serviceId}`, { headers: renderHeaders(apiKey) });
  const deploys = await fetchJson<Array<{ deploy?: { status?: string; id?: string; commit?: { id?: string } } }>>(
    `https://api.render.com/v1/services/${serviceId}/deploys?limit=1`,
    { headers: renderHeaders(apiKey) },
  );
  const latest = deploys[0]?.deploy;
  const issues: string[] = [];
  if (service.repo !== expectedRepo) issues.push(`repo is ${service.repo ?? "unknown"}`);
  if (service.branch !== expectedBranch) issues.push(`branch is ${service.branch ?? "unknown"}`);
  if (!latest) issues.push("no deploy found");
  if (latest && latest.status !== "live") issues.push(`latest deploy is ${latest.status ?? "unknown"}`);

  return {
    id: "render-paperclip",
    label: "Paperclip deploy",
    status: issues.length ? "error" : "ok",
    summary: issues.length ? "Paperclip deploy needs attention." : "Paperclip is wired to the expected Render repo and latest deploy is live.",
    detail: issues.length
      ? issues.join("; ")
      : `Repo ${expectedRepo}, branch ${expectedBranch}, deploy ${(latest?.commit?.id ?? "unknown").slice(0, 12)}.`,
    updatedAt,
  };
}

async function checkLiveBundle(): Promise<OpsStatusCheck> {
  const updatedAt = nowIso();
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || DEFAULT_PAPERCLIP_URL;
  const health = await fetchText(`${publicUrl}/api/health`, undefined, 8_000);
  if (!health.response.ok || !health.text.includes('"status":"ok"')) {
    return {
      id: "paperclip-live",
      label: "Live app",
      status: "error",
      summary: "Paperclip health check is not OK.",
      detail: `GET /api/health returned ${health.response.status}.`,
      updatedAt,
    };
  }

  const html = await fetchText(`${publicUrl}/Costs?ops_status=${Date.now()}`, undefined, 8_000);
  const asset = html.text.match(/\/assets\/[^"']+\.js/)?.[0];
  if (!asset) {
    return {
      id: "paperclip-live",
      label: "Live app",
      status: "warning",
      summary: "Paperclip is healthy, but the UI asset could not be checked.",
      updatedAt,
    };
  }
  const bundle = await fetchText(`${publicUrl}${asset}?ops_status=${Date.now()}`, undefined, 12_000);
  const missing = CURRENT_UI_MARKERS.filter((marker) => !bundle.text.includes(marker));
  return {
    id: "paperclip-live",
    label: "Live app",
    status: missing.length ? "warning" : "ok",
    summary: missing.length ? "Live UI may be stale." : "Live UI contains the current Article Creation markers.",
    detail: missing.length ? `Missing: ${missing.join(", ")}. Asset: ${asset}.` : `Asset: ${asset}.`,
    updatedAt,
  };
}

async function checkThomasBridge(): Promise<OpsStatusCheck> {
  const updatedAt = nowIso();
  const bridgeUrl = process.env.THOMAS_BRIDGE_HEALTH_URL?.trim() || DEFAULT_THOMAS_BRIDGE_URL;
  try {
    const { response, text } = await fetchText(bridgeUrl, undefined, 5_000);
    if (!response.ok) {
      return {
        id: "thomas-bridge",
        label: "Thomas bridge",
        status: "error",
        summary: "Thomas bridge is not responding cleanly.",
        detail: `Health returned HTTP ${response.status}.`,
        updatedAt,
      };
    }
    return {
      id: "thomas-bridge",
      label: "Thomas bridge",
      status: text.toLowerCase().includes("ok") ? "ok" : "warning",
      summary: text.toLowerCase().includes("ok") ? "Thomas bridge is reachable." : "Thomas bridge responded, but not with an OK health body.",
      updatedAt,
    };
  } catch (error) {
    return {
      id: "thomas-bridge",
      label: "Thomas bridge",
      status: "warning",
      summary: "Thomas bridge is not directly reachable from this web service.",
      detail: sanitizeOpsDetail(error),
      updatedAt,
    };
  }
}

function safeCheck(id: string, label: string, fn: () => Promise<OpsStatusCheck>) {
  return fn().catch((error): OpsStatusCheck => ({
    id,
    label,
    status: "warning",
    summary: `${label} check could not complete.`,
    detail: sanitizeOpsDetail(error),
    updatedAt: nowIso(),
  }));
}

export function opsStatusRoutes() {
  const router = Router();

  router.get("/", async (_req, res) => {
    const checks = await Promise.all([
      safeCheck("render-paperclip", "Paperclip deploy", checkRenderService),
      safeCheck("paperclip-live", "Live app", checkLiveBundle),
      safeCheck("thomas-bridge", "Thomas bridge", checkThomasBridge),
    ]);
    res.json({
      status: normalizeStatus(checks.map((check) => check.status)),
      checks,
    } satisfies OpsStatusResponse);
  });

  return router;
}
