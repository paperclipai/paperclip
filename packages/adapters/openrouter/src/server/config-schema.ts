/**
 * Declarative config schema for the OpenRouter adapter.
 *
 * Lets Paperclip's UI render the agent-config form without shipping a
 * bespoke React component. Mirrors the fields declared in
 * src/ui/build-config.ts so both paths stay in sync.
 */

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { models } from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "apiKey",
        label: "OpenRouter API Key",
        type: "text",
        required: true,
        hint: "Get a key at https://openrouter.ai/keys (sk-or-...). Prefer the OPENROUTER_API_KEY env var / Paperclip secret provider.",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        required: true,
        default: "openrouter/auto",
        options: models.map((m) => ({ label: m.label, value: m.id })),
        hint: "Select a model or use openrouter/auto for auto-routing. Append :free for the free tier.",
      },
      {
        key: "systemPrompt",
        label: "System Prompt",
        type: "textarea",
        hint: "Optional base instructions prepended to the wake payload.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        default: 0.7,
        hint: "Sampling temperature, 0–2.",
      },
      {
        key: "maxTokens",
        label: "Max Tokens",
        type: "number",
        default: 4096,
        hint: "Maximum completion tokens per turn.",
      },
      {
        key: "topP",
        label: "Top P",
        type: "number",
        default: 1,
        hint: "Nucleus sampling cutoff, 0–1.",
      },
      {
        key: "stream",
        label: "Enable Streaming",
        type: "toggle",
        default: true,
      },
      {
        key: "reasoning",
        label: "Enable Reasoning",
        type: "toggle",
        default: false,
        hint: "Only works with models that support extended thinking (DeepSeek R1, QwQ, etc.).",
      },
      {
        key: "route",
        label: "Routing Strategy",
        type: "select",
        default: "fallback",
        options: [
          { value: "fallback", label: "Fallback (auto-retry with other providers)" },
          { value: "no-fallback", label: "No Fallback (single provider only)" },
        ],
      },
      {
        key: "maxTurns",
        label: "Max Tool-Loop Turns",
        type: "number",
        default: 25,
        hint: "Maximum model tool-calls per run before the loop stops.",
      },
      {
        key: "autoApprove",
        label: "Auto-Approve Mutating Tools",
        type: "toggle",
        default: false,
        hint: "When on, hire_agent and similar actions skip the approval gate. Default off (approvals on).",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions File Path",
        type: "text",
        hint: "Optional absolute path to a markdown file read at runtime and prepended to the system prompt.",
      },
    ],
  };
}