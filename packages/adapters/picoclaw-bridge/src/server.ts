import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3000";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY ?? "";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY ?? "";
const PORT = Number(process.env.PORT ?? "4242");
const PICOCLAW_TIMEOUT_MS = Number(process.env.PICOCLAW_TIMEOUT_MS ?? "300000");

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "picoclaw-bridge", status: "ok", endpoint: "POST /invoke" });
});

app.post("/invoke", async (req, res) => {
  if (BRIDGE_API_KEY && req.headers["x-api-key"] !== BRIDGE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { runId, context } = req.body as { runId: string; context: Record<string, unknown> };
  if (!runId) {
    res.status(400).json({ error: "Missing runId" });
    return;
  }

  const prompt = buildPrompt(context);
  const session = `paperclip-${runId}`;

  res.status(202).json({ status: "accepted" });

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync("picoclaw", ["agent", "--session", session, "-m", prompt], {
      timeout: PICOCLAW_TIMEOUT_MS,
      env: { ...process.env },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    stderr = err instanceof Error ? err.message : String(err);
  }

  const succeeded = Boolean(stdout) && !stderr;
  await fetch(`${PAPERCLIP_URL}/api/heartbeat-runs/${runId}/callback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: succeeded ? "succeeded" : "failed",
      result: stdout.trim() || null,
      errorMessage: stderr || null,
    }),
  }).catch((err: unknown) => {
    console.error(`[picoclaw-bridge] callback failed for run ${runId}:`, err);
  });
});

function buildPrompt(context: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof context.taskTitle === "string") parts.push(`Task: ${context.taskTitle}`);
  if (typeof context.taskBody === "string" && context.taskBody) parts.push(context.taskBody);
  if (Array.isArray(context.comments)) {
    for (const c of context.comments) {
      if (typeof c?.body === "string") parts.push(`Comment: ${c.body}`);
    }
  }
  return parts.join("\n\n") || "No task context provided.";
}

app.listen(PORT, () => {
  console.log(`[picoclaw-bridge] listening on port ${PORT}`);
});
