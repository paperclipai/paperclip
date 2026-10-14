// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCatalogEntry } from "@paperclipai/shared";
import { ActionsSection } from "./PermissionsPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

const entry = (id: string, riskLevel: string) =>
  ({ id, toolName: id, title: id, riskLevel, status: "active" }) as unknown as ToolCatalogEntry;

describe("Permissions group control", () => {
  it("sets every action in the group in one change", () => {
    const onSetPermission = vi.fn();
    const writes = [entry("send", "write"), entry("delete", "destructive"), entry("label", "write")];
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ActionsSection
              connectionId="conn-1"
              appName="Gmail"
              readOnly={[entry("search", "read")]}
              canChange={writes}
              quarantined={[]}
              enabledIds={new Set(["search", "send", "delete", "label"])}
              askFirstIds={new Set(["delete"])}
              disabled={false}
              refreshPending={false}
              canConfigure
              onSetPermission={onSetPermission}
              onReviewQuarantined={vi.fn()}
              onRefreshActions={vi.fn()}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Set every action in Write (3)"]');
    expect(select).toBeTruthy();
    expect(select!.value).toBe("");
    flushSync(() => {
      select!.value = "ask";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onSetPermission).toHaveBeenCalledTimes(1);
    const [ids, next] = onSetPermission.mock.calls[0]!;
    expect([...ids].sort()).toEqual(["delete", "label", "send"]);
    expect(next).toBe("ask");
  });
});
