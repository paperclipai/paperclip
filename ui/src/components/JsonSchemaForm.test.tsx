// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonSchemaForm } from "./JsonSchemaForm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("JsonSchemaForm secret-ref rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders multiline secret-ref fields as textareas", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <JsonSchemaForm
          schema={{
            type: "object",
            properties: {
              sshPrivateKey: {
                type: "string",
                format: "secret-ref",
                maxLength: 4096,
              },
            },
          }}
          values={{ sshPrivateKey: "secret" }}
          onChange={() => {}}
        />,
      );
    });

    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
