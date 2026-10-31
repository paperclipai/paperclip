// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseFieldsPanel, CaseFieldsTable } from "./CaseFieldsPanel";

function act(callback: () => void) {
  flushSync(callback);
}

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CaseFieldsPanel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  function render(fields: Record<string, unknown>) {
    const root = createRoot(container);
    act(() => {
      root.render(<CaseFieldsPanel fields={fields} />);
    });
    return root;
  }

  it("shows the empty state when there are no fields", () => {
    const root = render({});
    expect(container.textContent).toContain("No fields set");
    act(() => root.unmount());
  });

  it("renders all four generic value types per spec", () => {
    const root = render({
      slug: "hermes-agent-post",
      word_count: 1850,
      published: true,
      draft_only: false,
      tags: ["ai", "launch"],
      publish_url: "https://example.com/post",
      related_case: "PAP-C12",
      missing: null,
      config: { nested: "x" },
    });

    // string
    expect(container.textContent).toContain("hermes-agent-post");
    // number — locale grouped, tabular
    expect(container.textContent).toContain("1,850");
    // string[] — chips
    expect(container.textContent).toContain("ai");
    expect(container.textContent).toContain("launch");
    // url → external link
    const urlLink = [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "https://example.com/post",
    );
    expect(urlLink).toBeTruthy();
    expect(urlLink?.getAttribute("target")).toBe("_blank");
    // case identifier → case link chip
    const caseLink = [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "/PAP/cases/PAP-C12",
    );
    expect(caseLink).toBeTruthy();
    // boolean never renders raw "true"/"false"
    expect(container.textContent).not.toContain("true");
    expect(container.textContent).not.toContain("false");
    // null → em-dash present
    expect(container.textContent).toContain("—");
    // object fallback → pretty-printed mono JSON block
    expect(container.textContent).toContain('"nested": "x"');
    // key insertion order preserved (slug before word_count)
    const text = container.textContent ?? "";
    expect(text.indexOf("slug")).toBeLessThan(text.indexOf("word_count"));

    act(() => root.unmount());
  });
});

describe("CaseFieldsTable", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(fields: Record<string, unknown>) {
    act(() => root.render(<CaseFieldsTable fields={fields} />));
    return [...container.querySelectorAll("tr")].map((row) => ({
      key: row.querySelector("th")?.textContent,
      value: row.querySelector("td")?.textContent,
    }));
  }

  it("flattens nested objects and single-record arrays in insertion order", () => {
    const rows = render({
      merchant: "Morning coffee",
      items: [{ quantity: 2, unitPrice: 3 }],
      payment: { result: { status: "settled" } },
    });

    expect(rows).toEqual([
      { key: "merchant", value: "Morning coffee" },
      { key: "items.quantity", value: "2" },
      { key: "items.unitPrice", value: "3" },
      { key: "payment.result.status", value: "settled" },
    ]);
    expect(container.querySelector("table")?.getAttribute("aria-label")).toBe("Case fields");
    expect([...container.querySelectorAll("th")].every((header) => header.scope === "row")).toBe(true);
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps indices for multiple records and nested or mixed arrays", () => {
    expect(render({
      items: [{ quantity: 2 }, { quantity: 4 }],
      results: ["pending", { ok: true }],
      coordinates: [[1, 2], [3, 4]],
    })).toEqual([
      { key: "items[0].quantity", value: "2" },
      { key: "items[1].quantity", value: "4" },
      { key: "results[0]", value: "pending" },
      { key: "results[1].ok", value: "true" },
      { key: "coordinates[0]", value: "[1,2]" },
      { key: "coordinates[1]", value: "[3,4]" },
    ]);
  });

  it("preserves empty structures, booleans, null, and primitive array types", () => {
    expect(render({
      nothing: null,
      enabled: false,
      approved: true,
      blank: "",
      metadata: {},
      items: [],
      values: ["2", 2, false, null],
    })).toEqual([
      { key: "nothing", value: "—" },
      { key: "enabled", value: "false" },
      { key: "approved", value: "true" },
      { key: "blank", value: '""' },
      { key: "metadata", value: "{}" },
      { key: "items", value: "[]" },
      { key: "values", value: '["2",2,false,null]' },
    ]);
  });

  it("retains each field when literal punctuation matches a flattened path", () => {
    expect(render({
      "items.quantity": "literal",
      items: [{ quantity: "nested" }],
      "records[0].id": "literal record",
      records: [{ id: "first" }, { id: "second" }],
    })).toEqual([
      { key: "items.quantity", value: "literal" },
      { key: "items.quantity", value: "nested" },
      { key: "records[0].id", value: "literal record" },
      { key: "records[0].id", value: "first" },
      { key: "records[1].id", value: "second" },
    ]);
  });

  it("links URLs, case identifiers and task identifiers without field controls", () => {
    render({
      source: { url: "https://example.com/receipt" },
      relatedCase: "PAP-C12",
      task: "PAP-812",
    });

    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/receipt", "/PAP/cases/PAP-C12", "/issues/PAP-812",
    ]);
    expect(links[0]?.target).toBe("_blank");
    expect(container.querySelector("button")).toBeNull();
  });

  it("preserves task links and surrounding text in identifier fields and arrays", () => {
    expect(render({
      task_identifiers: ["PAP-42", "Follow up PAP-43 after PAP-44", false, null],
      task_identifier: "See PAP-45 for the \"receipt\"",
    })).toEqual([
      { key: "task_identifiers", value: '["PAP-42","Follow up PAP-43 after PAP-44",false,null]' },
      { key: "task_identifier", value: 'See PAP-45 for the "receipt"' },
    ]);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/issues/PAP-42", "/issues/PAP-43", "/issues/PAP-44", "/issues/PAP-45",
    ]);
  });

  it("shows the empty state without an empty table", () => {
    render({});
    expect(container.textContent).toBe("No fields set");
    expect(container.querySelector("table")).toBeNull();
  });
});
