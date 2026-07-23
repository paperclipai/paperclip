// @vitest-environment jsdom

import type { Project } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

let ProjectProperties: typeof import("./ProjectProperties")["ProjectProperties"];

beforeAll(async () => {
  const sheetProto = window.CSSStyleSheet.prototype;
  const original = sheetProto.insertRule;
  sheetProto.insertRule = function patched(rule: string, index?: number) {
    try {
      return original.call(this, rule, index);
    } catch {
      return original.call(this, ".project-properties-test-noop{}", index);
    }
  };
  ({ ProjectProperties } = await import("./ProjectProperties"));
});

const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listUserSecretDefinitions: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("./environment-variables-editor", () => ({
  EnvironmentVariablesEditor: ({ onChange }: { onChange: (env: Record<string, unknown>) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ EXISTING: { type: "plain", value: "replacement" } })}
    >
      Save replacement
    </button>
  ),
}));

function project(): Project {
  const now = new Date("2026-07-14T00:00:00Z");
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    icon: null,
    env: null,
    envMetadata: {
      keys: ["EXISTING", "REMOVE_ME"],
      bindings: {
        EXISTING: { type: "plain", configured: true },
        REMOVE_ME: { type: "plain", configured: true },
      },
    },
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ProjectProperties write-only environment controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockGoalsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: false });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("removes one binding without requiring or exposing the others", () => {
    const onFieldUpdate = vi.fn();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <ProjectProperties project={project()} onFieldUpdate={onFieldUpdate} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove environment binding REMOVE_ME"]',
    );
    expect(removeButton).not.toBeNull();
    flushSync(() => removeButton?.click());

    expect(onFieldUpdate).toHaveBeenCalledWith("env", { envPatch: { remove: ["REMOVE_ME"] } });
    expect(container.textContent).not.toContain("replacement");
  });

  it("submits an isolated replacement while preserving untouched bindings", () => {
    const onFieldUpdate = vi.fn();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <ProjectProperties project={project()} onFieldUpdate={onFieldUpdate} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    const openButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Add or replace binding"),
    );
    flushSync(() => openButton?.click());
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save replacement",
    );
    flushSync(() => saveButton?.click());

    expect(onFieldUpdate).toHaveBeenCalledWith("env", {
      envPatch: { set: { EXISTING: { type: "plain", value: "replacement" } } },
    });
  });
});
