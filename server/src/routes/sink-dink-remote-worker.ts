import { Router } from "express";

type RemoteCreateRequest = {
  topic?: string;
  tone?: string;
  durationSec?: number;
  mediaPack?: Record<string, unknown>;
};

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getWorkerUrl(): string | null {
  const raw = process.env.MEDIA_WORKER_URL?.trim() || process.env.PAPERCLIP_MEDIA_WORKER_URL?.trim() || null;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function absoluteWorkerFileUrl(workerUrl: string, fileUrl: unknown): string | null {
  if (typeof fileUrl !== "string" || !fileUrl) return null;
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return `${workerUrl}${fileUrl.startsWith("/") ? "" : "/"}${fileUrl}`;
}

export function sinkDinkRemoteWorkerRoutes() {
  const router = Router();

  router.get("/sink-dink/remote-worker/status", (_req, res) => {
    const workerUrl = getWorkerUrl();
    res.json({
      ok: true,
      engine: "sink-dink-remote-worker-bridge",
      projectMode: "testing_project_only",
      renderMode: process.env.PAPERCLIP_MEDIA_RENDER_MODE || "remote_test",
      workerUrlConfigured: Boolean(workerUrl),
      workerHost: workerUrl ? new URL(workerUrl).host : null,
      endpoints: {
        status: "/api/sink-dink/remote-worker/status",
        create: "/api/sink-dink/remote-worker/create",
      },
      safety: {
        publishing: "blocked",
        humanApprovalRequired: true,
      },
    });
  });

  router.post("/sink-dink/remote-worker/create", async (req, res) => {
    const startedAt = new Date().toISOString();
    try {
      const workerUrl = getWorkerUrl();
      if (!workerUrl) {
        res.status(409).json({
          ok: false,
          errorType: "remote_worker_not_configured",
          safeMessage: "Set MEDIA_WORKER_URL to enable this bridge.",
          audit: { startedAt, completedAt: new Date().toISOString() },
        });
        return;
      }

      const body = (req.body ?? {}) as RemoteCreateRequest;
      const response = await fetch(`${workerUrl}/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: safeString(body.topic, "SINK DINK India family pressure test topic"),
          tone: safeString(body.tone, "respectful Hinglish"),
          durationSec: Math.max(10, Math.min(60, Number(body.durationSec) || 25)),
          mediaPack: body.mediaPack ?? undefined,
        }),
      });

      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }

      if (!response.ok) {
        res.status(502).json({ ok: false, errorType: "remote_worker_error", status: response.status, raw: parsed });
        return;
      }

      const payload = parsed as { jobId?: unknown; status?: unknown; files?: Array<{ file?: unknown; url?: unknown }> };
      const files = Array.isArray(payload.files)
        ? payload.files.map((file) => ({
            file: safeString(file.file, "output"),
            url: absoluteWorkerFileUrl(workerUrl, file.url),
          }))
        : [];

      res.json({
        ok: true,
        provider: "huggingface_space_worker",
        renderMode: "remote",
        workerHost: new URL(workerUrl).host,
        jobId: safeString(payload.jobId, "remote-job"),
        remoteStatus: payload.status ?? "unknown",
        files,
        humanApprovalRequired: true,
        raw: parsed,
        audit: { startedAt, completedAt: new Date().toISOString() },
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        errorType: "remote_worker_bridge_error",
        safeMessage: error instanceof Error ? error.message : "Unknown remote worker bridge error.",
        audit: { startedAt, completedAt: new Date().toISOString() },
      });
    }
  });

  return router;
}
