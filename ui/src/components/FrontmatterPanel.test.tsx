// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinFrontmatterBlock, splitFrontmatterBlock } from "@paperclipai/shared";
import {
  FrontmatterPanel,
  type FrontmatterPanelChange,
  type FrontmatterPanelProps,
} from "./FrontmatterPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flushUi(callback: () => void) {
  flushSync(callback);
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  flushUi(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element | null | undefined) {
  flushUi(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

function expandPanel(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-controls="frontmatter-panel-body"]');
  click(toggle);
}

describe("FrontmatterPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushUi(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<FrontmatterPanelProps> & { onChange?: (c: FrontmatterPanelChange) => void }) {
    const onChange = props.onChange ?? vi.fn();
    flushUi(() => {
      root.render(
        <FrontmatterPanel
          frontmatterText={props.frontmatterText ?? ""}
          hasFrontmatter={props.hasFrontmatter ?? false}
          fileName={props.fileName ?? "SKILL.md"}
          skillSlug={props.skillSlug}
          readOnly={props.readOnly}
          onChange={onChange}
        />,
      );
    });
    return onChange;
  }

  it("does not emit on mount — byte-identity round-trip is preserved when untouched", () => {
    const onChange = vi.fn();
    render({
      frontmatterText: "name: reflection-coach\ndescription: A helpful coach",
      hasFrontmatter: true,
      onChange,
    });
    expect(onChange).not.toHaveBeenCalled();
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-controls="frontmatter-panel-body"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#fm-name")).toBeNull();
    expandPanel(container);
    // The Fields tab is available for this round-trippable block after expansion.
    expect(container.querySelector<HTMLInputElement>("#fm-name")?.value).toBe("reflection-coach");
  });

  it("edits `name` in Fields mode and emits only that field changed", () => {
    const onChange = vi.fn();
    render({
      frontmatterText: "name: coach\ndescription: A coach",
      hasFrontmatter: true,
      onChange,
    });
    expandPanel(container);
    const nameInput = container.querySelector<HTMLInputElement>("#fm-name")!;
    setValue(nameInput, "new-coach");
    const last = onChange.mock.calls.at(-1)![0] as FrontmatterPanelChange;
    expect(last.frontmatterText).toBe("name: new-coach\ndescription: A coach");
    expect(last.hasFrontmatter).toBe(true);
  });

  it("edits allowed-tools via the chip input", () => {
    const onChange = vi.fn();
    render({
      frontmatterText: "name: coach\nallowed-tools:\n  - Read",
      hasFrontmatter: true,
      onChange,
    });
    expandPanel(container);
    const chipInput = container.querySelector<HTMLInputElement>('input[aria-label="Add tool"]')!;
    setValue(chipInput, "Grep");
    flushUi(() => {
      chipInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const last = onChange.mock.calls.at(-1)![0] as FrontmatterPanelChange;
    expect(last.frontmatterText).toBe("name: coach\nallowed-tools:\n  - Read\n  - Grep");
  });

  it("edits nested metadata scalar values", () => {
    const onChange = vi.fn();
    render({
      frontmatterText: "name: coach\nmetadata:\n  author: Paperclip\n  version: 2",
      hasFrontmatter: true,
      onChange,
    });
    expandPanel(container);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Value for author"]')!;
    setValue(valueInput, "Anthropic");
    const last = onChange.mock.calls.at(-1)![0] as FrontmatterPanelChange;
    // author changes; version stays a NUMBER (not requoted) because it was untouched.
    expect(last.frontmatterText).toBe("name: coach\nmetadata:\n  author: Anthropic\n  version: 2");
  });

  it("locks Fields mode for non-round-trippable YAML (inline comment) and preserves raw bytes", () => {
    const onChange = vi.fn();
    const raw = "name: coach # keep me\ndescription: A coach";
    render({ frontmatterText: raw, hasFrontmatter: true, onChange });
    expandPanel(container);

    // Fields tab is disabled; the YAML textarea is shown instead.
    const fieldsTab = findButtonByText(container, "Fields");
    expect(fieldsTab?.getAttribute("aria-disabled")).toBe("true");
    const yaml = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Frontmatter YAML"]');
    expect(yaml?.value).toBe(raw);
    expect(container.querySelector("#fm-name")).toBeNull();

    // Editing raw YAML passes through byte-for-byte.
    setValue(yaml!, `${raw}\nextra: value`);
    const last = onChange.mock.calls.at(-1)![0] as FrontmatterPanelChange;
    expect(last.frontmatterText).toBe(`${raw}\nextra: value`);
  });

  it("shows a warning chip for missing name/description on SKILL.md", () => {
    render({
      frontmatterText: "name: coach",
      hasFrontmatter: true,
      fileName: "SKILL.md",
    });
    const chip = container.querySelector('[data-testid="frontmatter-warning-chip"]');
    expect(chip?.textContent).toContain("issue");
  });

  it("flags a wrong-typed allowed-tools value instead of editing it as a list", () => {
    render({
      frontmatterText: "name: coach\ndescription: x\nallowed-tools: Read",
      hasFrontmatter: true,
    });
    expandPanel(container);
    expect(container.textContent).toContain("Expected a list");
  });

  it("adds frontmatter to a file that has none, seeding name from the slug", () => {
    const onChange = vi.fn();
    render({
      frontmatterText: "",
      hasFrontmatter: false,
      fileName: "SKILL.md",
      skillSlug: "reflection-coach",
      onChange,
    });
    const addButton = container.querySelector<HTMLButtonElement>('[data-testid="add-frontmatter"]');
    expect(addButton).toBeTruthy();
    click(addButton);
    const last = onChange.mock.calls.at(-1)![0] as FrontmatterPanelChange;
    expect(last.hasFrontmatter).toBe(true);
    expect(last.frontmatterText).toContain("name: reflection-coach");
    expect(last.frontmatterText).toContain("description:");
  });

  it("renders read-only fields without editing affordances", () => {
    render({
      frontmatterText: "name: coach\nallowed-tools:\n  - Read",
      hasFrontmatter: true,
      readOnly: true,
    });
    expandPanel(container);
    const nameInput = container.querySelector<HTMLInputElement>("#fm-name");
    expect(nameInput?.readOnly).toBe(true);
    // No chip remove buttons, no add-tool input.
    expect(container.querySelector('input[aria-label="Add tool"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove Read"]')).toBeNull();
  });

  it("keeps the full document byte-identical through split → panel → join with no edits", () => {
    const file = "---\nname: coach\ndescription: A coach\n---\n# Body\n\nHello world\n";
    const block = splitFrontmatterBlock(file);
    const onChange = vi.fn();
    render({
      frontmatterText: block.frontmatterText,
      hasFrontmatter: block.hasFrontmatter,
      onChange,
    });
    expect(onChange).not.toHaveBeenCalled();
    // The parent would rejoin the untouched block with the untouched body.
    expect(joinFrontmatterBlock(block)).toBe(file);
  });
});
