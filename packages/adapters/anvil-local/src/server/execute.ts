import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  asString,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  runChildProcess,
  ensureCommandResolvable,
} from "@paperclipai/adapter-utils/server-utils";

export const getConfigSchema = (): AdapterConfigSchema => {
  return {
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "claude",
        options: [
          { value: "claude", label: "Claude" },
          { value: "openai", label: "OpenAI" },
          { value: "custom", label: "Custom" },
          { value: "echo", label: "Echo" },
        ],
        hint: "Override the default provider backend.",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        hint: "Override the default model (e.g. gpt-4o, gemma-4-31b).",
        options: [
          { value: "mlx-community/gemma-4-31b-it-4bit", label: "Gemma 4 31B (LM Studio)" },
          { value: "/Users/angelhermon/.lmstudio/models/mlx-community/gemma-4-31b-it-4bit", label: "Gemma 4 31B (Local Path)" },
          { value: "gemma4:latest", label: "Gemma 4 (Ollama)" },
          { value: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B (Ollama)" },
        ],
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        hint: "Base URL override (useful for Ollama, vLLM, LM Studio).",
      },
      {
        key: "cwd",
        label: "Working Directory",
        type: "text",
        hint: "The absolute directory on disk where the process should run.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions File Path",
        type: "text",
        hint: "Absolute path to a markdown instructions file injected at runtime.",
      },
      {
        key: "instructionsRootPath",
        label: "Instructions Root Path",
        type: "text",
        hint: "Directory containing multiple .md instruction files to bundle.",
      },
      {
        key: "promptTemplate",
        label: "Prompt Template",
        type: "textarea",
        hint: "Template for the heartbeat prompt.",
      },
    ],
  };
};

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn } = ctx;

  const command = asString(config.command, "anvil");
  const cwd = asString(config.cwd, "") || process.cwd();
  const runtimeEnv = { ...process.env, ...buildPaperclipEnv(agent) } as Record<string, string>;
  
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const provider = asString(config.provider, "claude");
  const model = asString(config.model, "");
  const baseUrl = asString(config.baseUrl, "");

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  
  const templateData = { agent, context, runId };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  // Inject agent instructions
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsRootPath = asString(config.instructionsRootPath, "").trim();
  let instructionsContent = "";

  if (instructionsRootPath) {
    try {
      const entryFile = asString(config.instructionsEntryFile, "AGENTS.md").trim();
      const entries = await fs.readdir(instructionsRootPath);
      const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
      const orderedFiles = [
        entryFile,
        ...mdFiles.filter((f) => f !== entryFile),
      ].filter((f) => mdFiles.includes(f));

      const sections: string[] = [];
      for (const file of orderedFiles) {
        const filePath = path.join(instructionsRootPath, file);
        try {
          const content = await fs.readFile(filePath, "utf-8");
          sections.push(`<!-- ${file} -->\n${content.trim()}`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await onLog("stdout", `[paperclip] Warning: could not read instructions file "${filePath}": ${reason}\n`);
        }
      }
      instructionsContent = sections.join("\n\n");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog("stdout", `[paperclip] Warning: could not read instructions root "${instructionsRootPath}": ${reason}\n`);
    }
  } else if (instructionsFilePath) {
    try {
      instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog("stdout", `[paperclip] Warning: could not read instructions file "${instructionsFilePath}": ${reason}\n`);
    }
  }

  const goal = joinPromptSections([
    instructionsContent,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const args = ["run", "--provider", provider, "--goal", goal];
  if (model) args.push("--model", model);
  if (baseUrl) args.push("--base-url", baseUrl);

  if (onMeta) {
    await onMeta({
      adapterType: "anvil_local",
      command,
      cwd,
      commandArgs: args,
      env: buildPaperclipEnv(agent),
      prompt: goal,
      context,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env: runtimeEnv,
    onLog: (stream: "stdout" | "stderr", chunk: string) => onLog(stream, chunk),
    onSpawn,
    timeoutSec: 0,
    graceSec: 20,
  });

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: (proc.exitCode ?? 0) === 0 ? null : `Anvil exited with code ${proc.exitCode ?? -1}`,
    resultJson: { stdout: proc.stdout, stderr: proc.stderr },
    summary: proc.stdout,
    provider: provider,
    model: model,
    billingType: "fixed",
  };
}
