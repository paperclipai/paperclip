import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Response } from "express";

function writeEvent(res: Response, event: string, payload: unknown) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function pipeBrowserStreamToSse(
  _runId: string,
  res: Response,
  options?: { onFirstFrame?: () => void; scopeId?: string },
) {
  const scopeId = options?.scopeId ?? _runId;
  const artifactRoot = path.join(process.env.PAPERCLIP_HOME?.trim() || "/paperclip", "browser-artifacts");
  const safeScope = scopeId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const camoufoxFramePath = path.join(artifactRoot, `${safeScope}-camoufox.jpg`);
  let closed = false;
  let receivedFrame = false;
  let lastCamoufoxFrameMtime = 0;

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  writeEvent(res, "status", { status: "waiting", provider: "camoufox" });

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  const camoufoxPoll = setInterval(async () => {
    if (closed || res.writableEnded) return;
    try {
      const frameStat = await stat(camoufoxFramePath);
      if (frameStat.mtimeMs <= lastCamoufoxFrameMtime) return;
      const frame = await readFile(camoufoxFramePath);
      lastCamoufoxFrameMtime = frameStat.mtimeMs;
      if (!receivedFrame) {
        receivedFrame = true;
        options?.onFirstFrame?.();
        writeEvent(res, "status", { status: "live", provider: "camoufox" });
      }
      writeEvent(res, "frame", {
        data: frame.toString("base64"),
        metadata: { provider: "camoufox", capturedAt: frameStat.mtime.toISOString() },
      });
    } catch {
      // The managed Camoufox workflow has not published its first frame yet.
    }
  }, 300);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    clearInterval(camoufoxPoll);
  };
  res.on("close", cleanup);
  return cleanup;
}
