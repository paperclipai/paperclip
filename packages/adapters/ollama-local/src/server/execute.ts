import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface OllamaConfig {
  cwd?: string;
  model?: string;
  host?: string;
  numCtx?: number;
  temperature?: number;
  topP?: number;
  command?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

export interface OllamaExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}

export async function executeOllama(
  config: OllamaConfig,
  prompt: string,
  options?: { timeoutSec?: number; graceSec?: number }
): Promise<OllamaExecutionResult> {
  const {
    cwd,
    model = "llama3.2",
    host = "http://localhost:11434",
    numCtx,
    temperature,
    topP,
    command = "ollama",
    extraArgs = [],
    env = {},
  } = config;

  const { timeoutSec = 300, graceSec = 10 } = options || {};

  // Ensure working directory exists
  const workingDir = cwd || process.cwd();
  if (!existsSync(workingDir)) {
    mkdirSync(workingDir, { recursive: true });
  }

  // Build Ollama command
  const args = [
    "run",
    model,
    ...(numCtx ? ["--num-ctx", String(numCtx)] : []),
    ...(temperature !== undefined ? ["--temperature", String(temperature)] : []),
    ...(topP !== undefined ? ["--top-p", String(topP)] : []),
    ...extraArgs,
  ];

  // Set environment variables
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OLLAMA_HOST: host,
    ...env,
  };

  return new Promise((resolve) => {
    let output = "";
    let errorOutput = "";
    let child: ReturnType<typeof spawn> | null = null;

    const timeout = setTimeout(() => {
      if (child) {
        child.kill("SIGTERM");
        const graceTimer = setTimeout(() => {
          if (child) child.kill("SIGKILL");
        }, graceSec * 1000);
        
        // Clear grace timer on exit
        child.on("exit", () => clearTimeout(graceTimer));
      }
    }, timeoutSec * 1000);

    try {
      child = spawn(command, args, {
        cwd: workingDir,
        env: processEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      if (child.stdout) {
        child.stdout.on("data", (data) => {
          output += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });
      }

      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: err.message,
        });
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({
          success: code === 0,
          output: output || undefined,
          error: errorOutput || undefined,
          exitCode: code ?? undefined,
        });
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function testOllamaConnection(
  host: string = "http://localhost:11434"
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${host}/api/tags`);
    if (response.ok) {
      return { success: true };
    }
    return {
      success: false,
      error: `Ollama API returned ${response.status}: ${response.statusText}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
