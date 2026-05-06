import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "../types.js";
import type { OllamaLocalConfig } from "./config.js";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { asString } from "../utils.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

type AvailableSkill = Awaited<ReturnType<typeof readPaperclipRuntimeSkillEntries>>[number];

export interface SelectedOllamaSkill {
  key: string;
  description: string;
  body: string | null;
  required: boolean;
  sourcePath: string;
}

function lower(value: string) {
  return value.toLowerCase();
}

function extractDescription(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));
  return (lines[0] || "").slice(0, 240);
}

async function readSkillMarkdown(entry: AvailableSkill): Promise<string | null> {
  return fs.readFile(entry.source, "utf8").catch(() => null);
}

function deterministicSkillSelection(taskText: string, skills: SelectedOllamaSkill[]): Set<string> {
  const haystack = lower(taskText);
  const selected = new Set<string>();
  for (const skill of skills) {
    if (skill.required) {
      selected.add(skill.key);
      continue;
    }
    if (!skill.body) continue;
    const keyParts = skill.key.split(/[^a-zA-Z0-9]+/).filter((part) => part.length >= 3);
    const descParts = skill.description.split(/[^a-zA-Z0-9]+/).filter((part) => part.length >= 5);
    if ([...keyParts, ...descParts].some((token) => haystack.includes(lower(token)))) {
      selected.add(skill.key);
    }
  }
  if (selected.size === 0 && skills.length <= 3) {
    for (const skill of skills) {
      if (skill.body) selected.add(skill.key);
    }
  }
  return selected;
}

function tryParseSkillJson(raw: string): string[] | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { skills?: unknown }).skills)) {
        return (parsed as { skills: unknown[] }).skills.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

async function llmSkillSelection(options: {
  config: OllamaLocalConfig;
  taskText: string;
  skills: SelectedOllamaSkill[];
  onLog?: ((channel: "stdout" | "stderr", chunk: string) => Promise<void>) | undefined;
}): Promise<Set<string>> {
  const { config, taskText, skills, onLog } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5, config.ollamaTimeoutSec) * 1000);
  try {
    const response = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Return JSON only. Choose the smallest relevant set of skill keys for the Paperclip task. Output either a JSON array of keys or an object like {\"skills\":[...]}.",
          },
          {
            role: "user",
            content: [
              "Task:",
              taskText.slice(0, 5000),
              "Available skills:",
              JSON.stringify(
                skills.map((skill) => ({
                  key: skill.key,
                  description: skill.description,
                  required: skill.required,
                })),
                null,
                2,
              ),
            ].join("\n\n"),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const message = payload.message as { content?: unknown } | undefined;
    const content = asString(message?.content, "");
    const parsed = tryParseSkillJson(content);
    if (!parsed) {
      throw new Error("invalid JSON skill selection payload");
    }
    return new Set(parsed);
  } catch (error) {
    await onLog?.(
      "stderr",
      `[ollama_local:skills] llm skill selection failed, falling back to deterministic matching (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return deterministicSkillSelection(taskText, skills);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadOllamaSelectedSkills(options: {
  config: OllamaLocalConfig;
  taskText: string;
  onLog?: ((channel: "stdout" | "stderr", chunk: string) => Promise<void>) | undefined;
}): Promise<{ selectedSkills: SelectedOllamaSkill[]; describedSkills: SelectedOllamaSkill[] }> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(options.config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(options.config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const describedSkills: SelectedOllamaSkill[] = [];

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    const markdown = await readSkillMarkdown(entry);
    describedSkills.push({
      key: entry.key,
      description: markdown ? extractDescription(markdown) : "",
      body: markdown,
      required: Boolean(entry.required),
      sourcePath: entry.source,
    });
  }

  const selectedKeys =
    options.config.skillSelectionMode === "llm"
      ? await llmSkillSelection({
          config: options.config,
          taskText: options.taskText,
          skills: describedSkills,
          onLog: options.onLog,
        })
      : deterministicSkillSelection(options.taskText, describedSkills);

  const selectedSkills = describedSkills.filter(
    (skill) => skill.required || selectedKeys.has(skill.key),
  );

  return { selectedSkills, describedSkills };
}

async function buildOllamaSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Selected skills are injected into the next Ollama prompt when their content is relevant to the task."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "ollama_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOllamaLocalSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOllamaSkillSnapshot(ctx.config);
}

export async function syncOllamaLocalSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOllamaSkillSnapshot(ctx.config);
}
