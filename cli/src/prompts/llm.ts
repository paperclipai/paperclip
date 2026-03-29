import * as p from "@clack/prompts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LlmConfig } from "../config/schema.js";

const execFileAsync = promisify(execFile);

async function checkClaudeSubscription(): Promise<{ loggedIn: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed.loggedIn === true) {
      const sub = typeof parsed.subscriptionType === "string" ? ` (${parsed.subscriptionType})` : "";
      return { loggedIn: true, detail: `Logged in via Claude Code subscription${sub}` };
    }
    return { loggedIn: false, detail: "Claude CLI is installed but not logged in" };
  } catch {
    return { loggedIn: false, detail: "Could not run `claude auth status` — is Claude Code installed?" };
  }
}

export async function promptLlm(): Promise<LlmConfig | undefined> {
  const configureLlm = await p.confirm({
    message: "Configure an LLM provider now?",
    initialValue: false,
  });

  if (p.isCancel(configureLlm)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (!configureLlm) return undefined;

  const provider = await p.select({
    message: "LLM provider",
    options: [
      { value: "claude" as const, label: "Claude (subscription)" },
      { value: "openai" as const, label: "OpenAI" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (provider === "claude") {
    const status = await checkClaudeSubscription();
    if (status.loggedIn) {
      p.log.success(status.detail);
    } else {
      p.log.warn(status.detail);
      p.log.message("Run `claude login` to authenticate with your Claude Code subscription.");
    }
    // Subscription mode — no API key needed
    return { provider: "claude" };
  }

  const apiKey = await p.password({
    message: "OpenAI API key",
    validate: (val) => {
      if (!val) return "API key is required";
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return { provider, apiKey };
}
