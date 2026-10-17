// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { AiConnectionPicker, type AiConnectionPickerProps } from "./AiConnectionPicker";
import { GATEWAY } from "./import-claude-config-fixtures";

let root: Root | undefined;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const requirement = { companyId: "company-1", provider: "anthropic", method: "api_key" } as const;

/** One account as the connections list answers with it. */
const connection = (overrides: Record<string, unknown> = {}) => ({
  id: "connection-1",
  grantId: "grant-1",
  companyId: "company-1",
  provider: "anthropic" as const,
  method: "api_key" as const,
  name: "Imported from Claude config",
  ownership: "shared" as const,
  isDefault: false,
  status: "connected" as const,
  ...overrides,
});

function mount(overrides: Partial<AiConnectionPickerProps> = {}) {
  const props: AiConnectionPickerProps = {
    requirement,
    connections: [connection()],
    currentUserId: "user-1",
    agentId: "agent-1",
    agentName: "Nova",
    onChange: vi.fn(),
    onConnect: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(<AiConnectionPicker {...props} />));
  return { props, container };
}

describe("the AI connection chooser names the endpoint of each option", () => {
  it("appends the endpoint of a company-shared account that carries one", () => {
    // Two Anthropic accounts in one company can differ in nothing but the
    // endpoint (PRODUCT #30), so the row that picks between them has to say
    // which is which — in the same words the connection list uses.
    const { container } = mount({ connections: [connection({ baseUrl: GATEWAY })] });
    expect(container.textContent).toContain(`Custom endpoint · ${GATEWAY}`);
  });

  it("appends nothing for an account on the provider's official endpoint", () => {
    // Leaving the official ones unlabelled is what keeps the appended wording
    // meaning something: a row that named its endpoint everywhere would be
    // naming nothing.
    const { container } = mount();
    expect(container.textContent).not.toContain("Custom endpoint");
    expect(container.textContent).not.toContain("Official endpoint");
  });

  it("names the endpoint of the responsible user's own default too", () => {
    // The first row is a default account rather than a picked one, and it is
    // just as capable of pointing at a gateway.
    const { container } = mount({
      connections: [connection({ id: "personal", grantId: "grant-2", ownership: "personal", ownerUserId: "user-1", isDefault: true, baseUrl: GATEWAY })],
    });
    expect(container.textContent).toContain(`Custom endpoint · ${GATEWAY}`);
  });

  it("keeps the endpoint with its own account when both are listed", () => {
    const { container } = mount({
      connections: [
        connection({ id: "imported", grantId: "grant-1", baseUrl: GATEWAY }),
        connection({ id: "official", grantId: "grant-2", name: "My Claude API" }),
      ],
    });
    const rows = [...container.querySelectorAll("button")].map((node) => node.textContent ?? "");
    // One label, on the one account that has an endpoint to name (PRODUCT #30).
    expect(rows.filter((row) => row.includes(`Custom endpoint · ${GATEWAY}`))).toHaveLength(1);
    expect(rows.filter((row) => row.includes("Official endpoint"))).toHaveLength(0);
    // And the two rows are still told apart by name, so neither is the other.
    expect(rows.some((row) => row.includes("Imported from Claude config"))).toBe(true);
    expect(rows.some((row) => row.includes("My Claude API"))).toBe(true);
  });

  it("leaves the choice itself alone: the label is part of the description", () => {
    const onChange = vi.fn();
    const { container } = mount({ connections: [connection({ baseUrl: GATEWAY })], onChange });
    const option = [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Imported from Claude config")!;
    flushSync(() => option.click());
    expect(onChange).toHaveBeenCalledWith<[AiConnectionBinding]>(expect.objectContaining({
      mode: "shared",
      connectionId: "connection-1",
      grantId: "grant-1",
      provider: "anthropic",
      method: "api_key",
    }));
  });
});
