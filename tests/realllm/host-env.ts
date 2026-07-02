/**
 * Shared host dotenv hydration for Paperclip realllm (playwright.config + global setup).
 * Order: infra/.env → .env → `REALLLM_EXTRA_ENV_FILE`; later fills only unset/empty keys.
 */
import fs from "node:fs";
import path from "node:path";

export function loadHostEnv(repoRoot = process.cwd()): void {
  const rootDir = path.resolve(repoRoot);

  function loadEnvFile(filePath: string) {
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith("\"") && v.endsWith("\"")) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined || process.env[k] === "") {
        process.env[k] = v;
      }
    }
  }

  loadEnvFile(path.join(rootDir, "infra/.env"));
  loadEnvFile(path.join(rootDir, ".env"));

  const extraRaw = process.env.REALLLM_EXTRA_ENV_FILE?.trim();
  if (extraRaw) {
    const p = path.isAbsolute(extraRaw) ? extraRaw : path.join(rootDir, extraRaw);
    loadEnvFile(p);
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const auth = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!baseUrl && !apiKey && auth && !auth.startsWith("sk-ant-oat")) {
    process.env.ANTHROPIC_API_KEY = auth;
  }
}
