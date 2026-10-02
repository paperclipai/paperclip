// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteChatButton, type DeleteChatButtonProps } from "./DeleteChatButton";

let root: Root;
let container: HTMLDivElement;
let props: DeleteChatButtonProps;
async function render(overrides: Partial<DeleteChatButtonProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => { root.render(<DeleteChatButton {...props} />); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = { agentName: "Planner", onDelete: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DeleteChatButton", () => {
  it("does nothing until the confirmation dialog is accepted", async () => {
    await render();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Delete chat with Planner"]')!
        .click();
    });
    expect(document.querySelector("[role=alertdialog]")).not.toBeNull();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("calls onDelete and closes the dialog when the destructive action is confirmed", async () => {
    await render();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Delete chat with Planner"]')!
        .click();
    });
    await act(async () => {
      document
        .querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")[1]!
        .click();
    });
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("cancelling leaves the chat untouched", async () => {
    await render();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Delete chat with Planner"]')!
        .click();
    });
    await act(async () => {
      document
        .querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")[0]!
        .click();
    });
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });
});
