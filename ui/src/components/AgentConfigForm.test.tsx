// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-test" }),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <textarea value={value ?? ""} placeholder={placeholder} readOnly />
  ),
}));

import { defaultCreateValues } from "./agent-config-defaults";
import { AgentConfigForm } from "./AgentConfigForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderProviders(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{element}</TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
}

describe("AgentConfigForm HTTP adapter fields", () => {
  it("renders HTTP-specific operator fields on the create form even though HTTP is not a local adapter", () => {
    const values = { ...defaultCreateValues, adapterType: "http" };
    const rendered = renderProviders(
      <AgentConfigForm
        mode="create"
        values={values}
        onChange={() => undefined}
        showAdapterTypeField={false}
        showAdapterTestEnvironmentButton={false}
        showCreateRunPolicySection={false}
      />,
    );

    try {
      expect(rendered.container.textContent).toContain("Adapter Configuration");
      expect(rendered.container.textContent).toContain("Webhook URL");
      expect(rendered.container.textContent).toContain("Method");
      expect(rendered.container.textContent).toContain("Timeout (ms)");
      expect(rendered.container.textContent).toContain("Headers JSON");
      expect(rendered.container.textContent).toContain("Payload template JSON");
      expect(rendered.container.textContent).toContain("Env bindings");
      expect(rendered.container.textContent).not.toContain("Command");
    } finally {
      rendered.unmount();
    }
  });
});
