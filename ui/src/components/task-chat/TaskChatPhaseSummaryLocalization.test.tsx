// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { taskChatDisplayLabel } from "./task-chat-display";
import { taskChatPhaseSummaryDisplay } from "./task-chat-phase-summary-display";
import { buildActivityPhases } from "./transcript-adapter";
import type {
  TaskChatActivityPhaseItem, TaskChatItem, TaskChatProviderActivityFamily,
  TaskChatProviderActivityItem,
} from "./task-chat-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COUNTS = [1, 2, 5, 11, 21, 22, 25, 101, 111];
const COPY: Record<string, { single: string; multiple: string; reuseSingle?: boolean }> = {
  readFiles: { single: "Read a file", multiple: "Read {{count}} files", reuseSingle: true, },
  editedFiles: { single: "Edited a file", multiple: "Edited {{count}} files", reuseSingle: true, },
  commands: { single: "Ran a command", multiple: "Ran {{count}} commands", reuseSingle: true, },
  searches: { single: "Searched once", multiple: "Searched {{count}} times", },
  tools: { single: "Used a tool", multiple: "Used {{count}} tools", },
  plans: { single: "Updated the plan", multiple: "Updated {{count}} plans", reuseSingle: true, },
  subagents: { single: "Used a subagent", multiple: "Used {{count}} subagents", },
  modelUpdates: { single: "Updated the model", multiple: "Updated the model {{count}} times", },
  contextCompactions: { single: "Compacted context", multiple: "Compacted context {{count}} times", reuseSingle: true, },
  artifacts: { single: "Handled an artifact", multiple: "Handled {{count}} artifacts", },
  reviewChanges: { single: "Changed review mode", multiple: "Changed review mode {{count}} times", },
  hooks: { single: "Ran a hook", multiple: "Ran {{count}} hooks", reuseSingle: true, },
  memoryLookups: { single: "Referenced memory", multiple: "Referenced memory {{count}} times", reuseSingle: true, },
  safetyReviews: { single: "Ran a safety review", multiple: "Ran {{count}} safety reviews", },
  terminalInputs: { single: "Sent terminal input", multiple: "Sent terminal input {{count}} times", reuseSingle: true, },
  waits: { single: "Waited", multiple: "Waited {{count}} times", },
  providerNotices: { single: "Received a provider notice", multiple: "Received {{count}} provider notices", },
  toolSearches: { single: "Searched available tools", multiple: "Searched available tools {{count}} times", reuseSingle: true, },
  paperclipReads: { single: "Read from Paperclip", multiple: "Read from Paperclip {{count}} times", },
  paperclipUses: { single: "Used Paperclip", multiple: "Used Paperclip {{count}} times", },
  changedFiles: { single: "Changed a file", multiple: "Changed {{count}} files", },
  runnerUpdates: { single: "Runner activity", multiple: "{{count}} runner updates", },
};

function provider(family: TaskChatProviderActivityFamily, index: number, name?: string, namespace?: string): TaskChatProviderActivityItem {
  return {
    id: `${family}-${name ?? "event"}-${index}`,
    kind: "protocol", surface: "provider_activity", family,
    eventType: `${family}.completed`, status: "completed",
    title: "Keep provider title", summary: "Read a file, but keep this provider summary",
    output: "Keep provider output", details: [
      ...(name ? [{ label: "Name", value: name }] : []),
      ...(namespace ? [{ label: "Namespace", value: namespace }, { label: "Transport", value: "mcp" }] : []),
    ],
    steps: [], links: [], children: [],
  };
}

function tools(name: string, count: number): TaskChatItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${name}-${index}`, kind: "tool", name, rawName: name, status: "completed",
  }));
}

const fixtureKinds: Array<{ name: string; key: string; items: (count: number) => TaskChatItem[] }> = [
  ...[
    ["native reads", "readFiles", "Read"],
    ["native edits", "editedFiles", "Edit"],
    ["native commands", "commands", "Bash"],
    ["native grep", "searches", "Grep"],
    ["native search", "searches", "Glob"],
    ["generic tools", "tools", "tool call"],
    ["other native tools", "tools", "vendor_magic"],
  ].map(([name, key, tool]) => ({ name: name!, key: key!, items: (count: number) => tools(tool!, count) })),
  ...([
    ["plan", "plans"], ["tool_execution", "tools"], ["research", "searches"],
    ["delegation", "subagents"], ["model_identity", "modelUpdates"], ["context", "contextCompactions"],
    ["artifact", "artifacts"], ["review", "reviewChanges"], ["hook", "hooks"], ["memory", "memoryLookups"],
    ["safety", "safetyReviews"], ["terminal", "terminalInputs"], ["wait", "waits"], ["provider_notice", "providerNotices"],
  ] as const).map(([family, key]) => ({
    name: `provider ${family}`, key,
    items: (count: number) => Array.from({ length: count }, (_, index) => provider(family, index)),
  })),
  ...[
    ["command", "commands", "bash", undefined],
    ["read", "readFiles", "read", undefined],
    ["search", "searches", "grep", undefined],
    ["file_change", "editedFiles", "edit", undefined],
    ["delegation", "subagents", "spawn_agent", undefined],
    ["wait", "waits", "wait", undefined],
    ["tool_search", "toolSearches", "ToolSearch", undefined],
    ["paperclip_read", "paperclipReads", "get_task_context", "paperclip"],
    ["task_operation", "paperclipUses", "report_progress", "paperclip"],
    ["fallback", "tools", "vendor_magic", undefined],
  ].map(([group, key, name, namespace]) => ({
    name: `provider tool group ${group}`, key: key!,
    items: (count: number) => Array.from({ length: count }, (_, index) => provider("tool_execution", index, name, namespace)),
  })),
  {
    name: "workspace files", key: "changedFiles",
    items: (count) => Array.from({ length: count }, (_, index) => ({
      id: `file-${index}`, kind: "protocol", surface: "workspace_file",
      referenceId: `ref-${index}`, source: "runner_verified", path: "Keep English Filename.ts",
      displayName: "Keep English Filename.ts", mediaType: null, presentation: "code",
      line: null, preview: "Keep source code", previewTruncated: false,
    })),
  },
  {
    name: "runner updates", key: "runnerUpdates",
    items: (count) => Array.from({ length: count }, (_, index) => ({
      id: `resource-${index}`, kind: "protocol", surface: "resource", resourceKind: "document",
      title: "Keep resource title", subtitle: "Keep resource subtitle", href: null,
    })),
  },
];

describe("TaskChatActivityPhase generated-summary localization", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });
  async function render(item: TaskChatActivityPhaseItem) {
    await act(async () => {
      root.render(<ThemeProvider><TaskChatActivityPhase item={item} autoOpen={false} renderChild={(child) => (
        <span data-testid="raw-child">{child.kind === "tool" ? child.name : child.kind === "protocol" && child.surface === "provider_activity"
          ? `${child.title} | ${child.summary} | ${child.output}` : child.id}</span>
      )} /></ThemeProvider>);
    });
  }
  async function locale(language: string) {
    await act(async () => { await i18n.changeLanguage(language); });
  }

  it.each(fixtureKinds.flatMap((fixture) => COUNTS.map((count) => ({ ...fixture, count }))))(
    "$name: count=$count remains canonical while its visible and accessible summaries switch",
    async ({ key, items, count }) => {
      const input = items(count);
      const beforeInput = JSON.stringify(input);
      const phase = buildActivityPhases(input, false)[0]!;
      expect(phase).toBeDefined();
      const copy = COPY[key]!;
      const canonical = count === 1 ? copy.single : copy.multiple.replace("{{count}}", String(count));
      expect(phase.summary).toBe(canonical);
      const beforePhase = JSON.stringify(phase);
      await render(phase);
      const button = host.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]')!;
      expect(button.textContent).toBe(canonical);

      for (const language of ["ru", "en", "ru"]) {
        await locale(language);
        const localized = count === 1 && key === "runnerUpdates"
          ? i18n.t("localizationPhaseSummary.runnerActivity")
          : count === 1 && copy.reuseSingle
            ? taskChatDisplayLabel(copy.single)
            : i18n.t(`localizationPhaseSummary.${key}`, { count });
        const expected = language === "en" ? canonical : localized;
        expect(host.querySelector('[data-testid="task-chat-phase-summary"]')).toBe(button);
        expect(button.textContent).toBe(expected);
        expect(button.getAttribute("aria-label")).toBe(i18n.t("localizationTaskRuntime.expandActivity", { summary: expected }));
        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(expected).not.toContain("localization");
        if (language === "ru") {
          expect(expected).toMatch(/[а-яё]/i);
          if (count !== 1) expect(expected).toContain(String(count));
        }
        expect(phase.summary).toBe(canonical);
        expect(JSON.stringify(phase)).toBe(beforePhase);
        expect(JSON.stringify(input)).toBe(beforeInput);
        expect(buildActivityPhases(input, false)[0]!.summary).toBe(canonical);
      }
    },
  );

  it.each([
    [1, "Файл прочитан"], [2, "Прочитано 2 файла"], [5, "Прочитано 5 файлов"],
    [11, "Прочитано 11 файлов"], [21, "Прочитан 21 файл"], [22, "Прочитано 22 файла"],
    [25, "Прочитано 25 файлов"], [101, "Прочитан 101 файл"], [111, "Прочитано 111 файлов"],
  ] as const)("uses Russian file agreement for %i", async (count, expected) => {
    const phase = buildActivityPhases(tools("Read", count), false)[0]!;
    await render(phase);
    await locale("ru");
    expect(host.querySelector('[data-testid="task-chat-phase-summary"]')?.textContent).toBe(expected);
  });

  it.each(COUNTS)("localizes +%i hidden actions and keeps the expanded subtree through live switching", async (hidden) => {
    const phase = buildActivityPhases([
      ...tools("Read", 1), ...tools("Edit", 2), ...tools("Bash", 5),
      ...Array.from({ length: hidden }, (_, index) => provider("provider_notice", index)),
    ], false)[0]!;
    expect(phase.summary).toBe(`Read a file, edited 2 files, ran 5 commands, +${hidden} more`);
    phase.interstitial = {
      id: "commentary", kind: "message", author: "agent", text: "Keep user-authored English update.",
      interstitial: true, channel: "progress",
    };
    const before = JSON.stringify(phase);
    await render(phase);
    const button = host.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]')!;
    await act(async () => button.click());
    const subtree = host.querySelector('[data-testid="task-chat-phase-children"]')!;
    const rawChild = subtree.querySelector('[data-testid="raw-child"]');
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector('[data-testid="task-chat-phase-summary"]')).toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector('[data-testid="task-chat-phase-children"]')).toBe(subtree);
      expect(subtree.querySelector('[data-testid="raw-child"]')).toBe(rawChild);
      const expected = language === "en" ? phase.summary
        : `Файл прочитан, изменено 2 файла, выполнено 5 команд, ещё ${hidden}`;
      expect(button.textContent).toBe(expected);
      expect(button.getAttribute("aria-label")).toBe(i18n.t("localizationTaskRuntime.collapseActivity", { summary: expected }));
      expect(host.textContent).toContain("Keep provider title");
      expect(host.textContent).toContain("Read a file, but keep this provider summary");
      expect(host.textContent).toContain("Keep provider output");
      expect(host.textContent).toContain("Keep user-authored English update.");
      expect(JSON.stringify(phase)).toBe(before);
    }
  });

  it("preserves Paperclip capitalization at a joined phrase boundary", async () => {
    const phase = buildActivityPhases([
      provider("tool_execution", 0, "ToolSearch"),
      provider("tool_execution", 1, "report_progress", "paperclip"),
    ], false)[0]!;
    await render(phase);
    await locale("ru");
    expect(phase.summary).toBe("Searched available tools, used Paperclip");
    expect(host.querySelector('[data-testid="task-chat-phase-summary"]')?.textContent)
      .toContain(", Paperclip использован 1 раз");
  });

  it.each([
    ["Reasoning", "Рассуждения", { id: "reason", kind: "thinking", lines: ["Keep provider reasoning"] }],
    ["No tool activity", "Действий с инструментами нет", { id: "usage", kind: "usage", usage: { used: 1, size: 100 } }],
    ["Run interrupted", "Запуск прерван", { id: "marker", kind: "marker", variant: "interrupted", label: "Run interrupted" }],
  ] as const)("localizes fixed fallback %s without changing raw child content", async (source, expected, child) => {
    const phase = buildActivityPhases([child as TaskChatItem], false)[0]!;
    expect(phase.summary).toBe(source);
    await render(phase);
    await locale("ru");
    expect(host.querySelector('[data-testid="task-chat-phase-summary"]')?.textContent).toBe(expected);
    expect(phase.summary).toBe(source);
  });

  it.each(["Read a file", "Read 21 files", "Reasoning", "Runner activity"])("does not mistake a custom interruption label for a generated summary: %s", async (summary) => {
    const phase = buildActivityPhases([
      { id: "custom-marker", kind: "marker", variant: "interrupted", label: summary },
    ], false)[0]!;
    expect(phase.summary).toBe(summary);
    await render(phase);
    await locale("ru");
    expect(host.querySelector('[data-testid="task-chat-phase-summary"]')?.textContent).toBe(summary);
    expect(phase.summary).toBe(summary);
  });

  it.each([
    "Keep provider summary", "Read a file, and keep user text", "Read a file, +2 more",
    "Read 1 files", "Read 0 files", "Read 02 files", "Read 2 files.", "Read 2 files\nKeep text",
    "Read 9007199254740992 files", "2 runner updates, read a file",
    "Read a file, ran a command, used a tool, +0 more",
    "Read a file, ran a command, used a tool, received a provider notice",
  ])("leaves unknown/noncanonical grammar untouched: %s", async (summary) => {
    const phase: TaskChatActivityPhaseItem = {
      id: "unknown", kind: "activity_phase", summary, active: false,
      items: [{ id: "marker", kind: "marker", variant: "interrupted", label: summary }],
    };
    await render(phase);
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(taskChatPhaseSummaryDisplay(summary)).toBe(summary);
      const button = host.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]')!;
      expect(button.textContent).toBe(summary);
      expect(button.getAttribute("aria-label")).toBe(i18n.t("localizationTaskRuntime.expandActivity", { summary }));
      expect(phase.summary).toBe(summary);
    }
  });
});
