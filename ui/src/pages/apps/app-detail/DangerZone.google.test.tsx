// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";

vi.mock("@/api/tools", () => ({ toolsApi: {} }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

import { DangerZone } from "./AdvancedPanel";
import { GOOGLE_CONTENT_DELETION_NOTICE } from "@/features/connections/googleAccessRemoval";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

async function renderDangerZone(config: Record<string, unknown>) {
  const connection = { id: "c1", authKind: "oauth", status: "active", enabled: true, config } as unknown as ToolConnection;
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <DangerZone appName="Google Workspace" connection={connection} removing={false} onRemove={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { container!.querySelector("button")!.click(); });
  return document.body.textContent ?? "";
}

describe("removing a Google connection", () => {
  it("says that what agents read from Google is deleted", async () => {
    expect(await renderDangerZone({ sourceTemplateKey: "google-workspace" })).toContain(GOOGLE_CONTENT_DELETION_NOTICE);
  });

  it("does not say so for other apps", async () => {
    expect(await renderDangerZone({ sourceTemplateKey: "slack" })).not.toContain(GOOGLE_CONTENT_DELETION_NOTICE);
  });
});
