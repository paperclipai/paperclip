// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_INSTALL_FORM,
  useInstallTeamCatalogEntry,
  type TeamInstallFormState,
  type UseInstallTeamCatalogEntryResult,
} from "./TeamCatalog";
import { sampleTeam } from "./TeamCatalog.fixtures";

const mockTeamCatalogApi = vi.hoisted(() => ({
  catalogList: vi.fn(),
  catalogDetail: vi.fn(),
  catalogFile: vi.fn(),
  preview: vi.fn(),
  install: vi.fn(),
}));

vi.mock("../api/teamCatalog", () => ({ teamCatalogApi: mockTeamCatalogApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

// Capture the live hook result so assertions can read it and drive its actions.
let captured: UseInstallTeamCatalogEntryResult | null = null;

function Harness({ simplified }: { simplified: boolean }) {
  captured = useInstallTeamCatalogEntry({
    companyId: "company-1",
    team: sampleTeam,
    simplified,
  });
  return null;
}

async function renderHook(simplified: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness simplified={simplified} />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return () => {
    root.unmount();
    container.remove();
  };
}

describe("useInstallTeamCatalogEntry", () => {
  beforeEach(() => {
    captured = null;
    mockTeamCatalogApi.preview.mockResolvedValue({});
    mockTeamCatalogApi.install.mockResolvedValue({ portabilityImport: {}, skillPreparations: [], warnings: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("standard flow surfaces the target-manager and source-policy steps", async () => {
    // sampleTeam has root agents + an unpinned external source.
    const cleanup = await renderHook(false);
    expect(captured!.steps).toContain("target_manager");
    expect(captured!.steps).toContain("source_policy");
    cleanup();
  });

  it("simplified flow drops target-manager and source-policy steps", async () => {
    const cleanup = await renderHook(true);
    expect(captured!.steps).not.toContain("target_manager");
    expect(captured!.steps).not.toContain("source_policy");
    // Required skills still resolve, preview is always last.
    expect(captured!.steps[captured!.steps.length - 1]).toBe("preview");
    cleanup();
  });

  it("simplified flow forces a full-company-equivalent target (null manager)", async () => {
    const cleanup = await renderHook(true);
    const form: TeamInstallFormState = {
      ...EMPTY_INSTALL_FORM,
      targetManagerAgentId: "agent-should-be-ignored",
    };
    expect(captured!.buildPreviewOptions(form).targetManagerAgentId).toBeNull();
    expect(captured!.buildInstallOptions(form).targetManagerAgentId).toBeNull();
    cleanup();
  });

  it("standard flow honors the chosen target manager and adapter overrides", async () => {
    const cleanup = await renderHook(false);
    const form: TeamInstallFormState = {
      ...EMPTY_INSTALL_FORM,
      targetManagerAgentId: "agent-7",
      adapterOverrides: { ceo: "codex_local" },
    };
    const preview = captured!.buildPreviewOptions(form);
    expect(preview.targetManagerAgentId).toBe("agent-7");
    const install = captured!.buildInstallOptions(form);
    expect(install.adapterOverrides).toEqual({ ceo: { adapterType: "codex_local" } });
    cleanup();
  });

  it("runInstall calls the install API and resolves to the done phase", async () => {
    const cleanup = await renderHook(true);
    await act(async () => {
      captured!.runInstall(EMPTY_INSTALL_FORM);
    });
    await flushReact();
    expect(mockTeamCatalogApi.install).toHaveBeenCalledTimes(1);
    expect(mockTeamCatalogApi.install).toHaveBeenCalledWith(
      "company-1",
      sampleTeam.id,
      expect.objectContaining({ targetManagerAgentId: null }),
    );
    expect(captured!.phase).toBe("done");
    cleanup();
  });
});
