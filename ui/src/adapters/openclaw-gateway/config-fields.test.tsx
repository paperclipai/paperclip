// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OpenClawGatewayConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("OpenClawGatewayConfigFields", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("hides legacy auth headers and writes replacements to authToken", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const mark = vi.fn();
    const props: AdapterConfigFieldsProps = {
      mode: "edit",
      isCreate: false,
      adapterType: "openclaw_gateway",
      values: null,
      set: null,
      config: { headers: { "X-OpenClaw-Token": "synthetic-token", "x-trace-id": "keep" } },
      eff: (_group, _field, original) => original,
      mark,
      models: [],
    };

    act(() => root.render(<TooltipProvider><OpenClawGatewayConfigFields {...props} /></TooltipProvider>));

    const tokenInput = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      .find((input) => input.placeholder.includes("Stored secret"));
    expect(tokenInput).toBeTruthy();
    const textareas = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea"));
    expect(textareas.some((textarea) => textarea.value.includes("x-trace-id"))).toBe(true);
    expect(textareas.every((textarea) => !textarea.value.includes("synthetic-token"))).toBe(true);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        .call(tokenInput, "replacement-token");
      tokenInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "authToken", "replacement-token");
    expect(mark).toHaveBeenCalledWith("adapterConfig", "headers", { "x-trace-id": "keep" });
  });
});
