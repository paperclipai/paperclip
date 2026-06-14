import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeLinearWebhookFixture } from "../services/linear-webhook-fixtures.js";

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const name = args[0];
  const outputPath = args[1];

  if (!name || !outputPath) {
    throw new Error("Usage: pnpm --filter @paperclipai/server exec tsx src/scripts/record-linear-webhook-fixture.ts <fixture-name> <output-path> < raw-webhook.json");
  }

  const raw = await readStdin();
  const parsed = JSON.parse(raw) as { headers?: Record<string, unknown>; body?: Record<string, unknown> } | Record<string, unknown>;
  const body = "body" in parsed && parsed.body && typeof parsed.body === "object"
    ? parsed.body as Record<string, unknown>
    : parsed as Record<string, unknown>;
  const headers = "headers" in parsed && parsed.headers && typeof parsed.headers === "object"
    ? parsed.headers as Record<string, unknown>
    : {};

  const fixture = sanitizeLinearWebhookFixture({ name, headers, body });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Recorded sanitized Linear webhook fixture: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
