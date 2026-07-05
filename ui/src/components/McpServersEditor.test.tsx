// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, McpServersConfig } from "@paperclipai/shared";
import { McpServersEditor, MCP_CAPABLE_ADAPTER_TYPES } from "./McpServersEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const servers: McpServersConfig = {
  github: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  linear: {
    transport: "http",
    url: "https://mcp.linear.app/mcp",
  },
};

function noopCreateSecret(): Promise<CompanySecret> {
  return Promise.reject(new Error("not implemented"));
}

describe("McpServersEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders configured servers with transport badges", () => {
    act(() => {
      root.render(
        <McpServersEditor
          value={servers}
          secrets={[]}
          onCreateSecret={noopCreateSecret}
          onChange={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("github");
    expect(container.textContent).toContain("stdio");
    expect(container.textContent).toContain("linear");
    expect(container.textContent).toContain("http");
    expect(container.textContent).toContain("Add MCP server");
  });

  it("removes a server via the row remove button", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <McpServersEditor
          value={servers}
          secrets={[]}
          onCreateSecret={noopCreateSecret}
          onChange={onChange}
        />,
      );
    });
    const removeButton = container.querySelector<HTMLButtonElement>('button[title="Remove github"]');
    expect(removeButton).not.toBeNull();
    act(() => {
      removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ linear: servers.linear });
  });

  it("emits undefined when the last server is removed", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <McpServersEditor
          value={{ github: servers.github }}
          secrets={[]}
          onCreateSecret={noopCreateSecret}
          onChange={onChange}
        />,
      );
    });
    const removeButton = container.querySelector<HTMLButtonElement>('button[title="Remove github"]');
    act(() => {
      removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("exposes the MCP-capable adapter allowlist", () => {
    expect(MCP_CAPABLE_ADAPTER_TYPES.has("claude_local")).toBe(true);
    expect(MCP_CAPABLE_ADAPTER_TYPES.has("opencode_local")).toBe(true);
    expect(MCP_CAPABLE_ADAPTER_TYPES.has("http_webhook")).toBe(false);
  });

  it("shows OAuth connection state and starts the flow via onStartOauth", async () => {
    const oauthServers: McpServersConfig = {
      sentry: {
        transport: "http",
        url: "https://mcp.sentry.dev/mcp",
        auth: { type: "oauth", secretId: "00000000-0000-4000-8000-000000000003" },
      },
      notion: {
        transport: "sse",
        url: "https://mcp.notion.com/sse",
        auth: { type: "oauth", secretId: null },
      },
    };
    const onStartOauth = vi.fn(() => Promise.resolve());
    act(() => {
      root.render(
        <McpServersEditor
          value={oauthServers}
          secrets={[]}
          onCreateSecret={noopCreateSecret}
          onChange={vi.fn()}
          onStartOauth={onStartOauth}
        />,
      );
    });
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Reconnect");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const connectButton = buttons.find((button) => button.textContent === "Connect");
    expect(connectButton).toBeDefined();
    await act(async () => {
      connectButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStartOauth).toHaveBeenCalledWith("notion");
  });

  it("renders a plain OAuth badge when no onStartOauth handler is provided", () => {
    const oauthServers: McpServersConfig = {
      notion: {
        transport: "sse",
        url: "https://mcp.notion.com/sse",
        auth: { type: "oauth", secretId: null },
      },
    };
    act(() => {
      root.render(
        <McpServersEditor
          value={oauthServers}
          secrets={[]}
          onCreateSecret={noopCreateSecret}
          onChange={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("OAuth");
    expect(container.textContent).not.toContain("Connect");
  });
});
