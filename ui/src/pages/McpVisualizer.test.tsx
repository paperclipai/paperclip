// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpVisualizer } from "./McpVisualizer";

const mockSetBreadcrumbs = vi.fn();

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// lucide renders SVGs fine in jsdom, but a tiny mock keeps this page test focused
// on copy/layout semantics instead of icon implementation details.
vi.mock("lucide-react", () => {
  const Icon = ({ children }: { children?: ReactNode }) => <svg aria-hidden="true">{children}</svg>;
  return {
    ArrowRight: Icon,
    Bot: Icon,
    Braces: Icon,
    CheckCircle2: Icon,
    Database: Icon,
    FileCode2: Icon,
    GitBranch: Icon,
    Network: Icon,
    SearchCode: Icon,
    ServerCog: Icon,
    ShieldCheck: Icon,
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(<McpVisualizer />);
  });
  return container;
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe("McpVisualizer", () => {
  it("renders the codebase-memory-mcp topology and safety posture", () => {
    const view = renderPage();

    expect(view.textContent).toContain("Codebase MCP visualizer");
    expect(view.textContent).toContain("codebase-memory-mcp");
    expect(view.textContent).toContain("/root/.local/bin/codebase-memory-mcp");
    expect(view.textContent).toContain("/root/.codex/config.toml");
    expect(view.textContent).toContain("index_repository");
    expect(view.textContent).toContain("search_graph");
    expect(view.textContent).toContain("trace_path");
    expect(view.textContent).toContain("Read-only discovery surface");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Dashboard", href: "/dashboard" },
      { label: "MCP Visualizer" },
    ]);
  });
});
