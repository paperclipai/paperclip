import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { HelperConfig } from "./config.js";
import { openArgs, revealArgs, type CommandSpec } from "./platform.js";
import { ValidationError, validatePath } from "./validate-path.js";

const execFileAsync = promisify(execFile);

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  OUTSIDE_ROOTS: 403,
  BAD_PATH: 400,
};

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

export async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  config: HelperConfig | null,
  action: "open" | "reveal",
) {
  if (!config) {
    sendJson(res, 503, { error: "not configured" });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "invalid json" });
    return;
  }

  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { path?: unknown }).path !== "string"
  ) {
    sendJson(res, 400, { error: "missing path field" });
    return;
  }

  const rawPath = (body as { path: string }).path;

  let resolvedPath: string;
  try {
    resolvedPath = validatePath(rawPath, config.roots);
  } catch (err) {
    if (err instanceof ValidationError) {
      sendJson(res, STATUS_BY_CODE[err.code] ?? 400, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: "validation failed" });
    return;
  }

  let spec: CommandSpec;
  try {
    spec = action === "open" ? openArgs(resolvedPath) : revealArgs(resolvedPath);
  } catch (err) {
    sendJson(res, 501, { error: (err as Error).message });
    return;
  }

  try {
    await execFileAsync(spec.cmd, spec.args, { timeout: 5000 });
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) {
      sendJson(res, 504, { error: "timeout" });
      return;
    }
    sendJson(res, 502, { error: `open failed: ${e.stderr || e.message || "unknown"}` });
    return;
  }

  sendJson(res, 200, { ok: true });
}
