// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinancialEventEntry } from "./FinancialEventEntry";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  invoice: vi.fn(),
  provider: vi.fn(),
  secrets: vi.fn(),
}));
vi.mock("../api/costs", () => ({
  costsApi: { createFinanceEvent: mocks.create },
}));
vi.mock("../api/accounting", () => ({
  accountingApi: {
    importInvoice: mocks.invoice,
    importProviderCosts: mocks.provider,
  },
}));
vi.mock("../api/secrets", () => ({ secretsApi: { list: mocks.secrets } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("financial event entry", () => {
  let root: ReturnType<typeof createRoot>,
    container: HTMLDivElement,
    client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.create.mockResolvedValue({});
    mocks.invoice.mockResolvedValue({});
    mocks.secrets.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  async function render(companyId = "company-one") {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FinancialEventEntry companyId={companyId} />
        </QueryClientProvider>,
      ),
    );
    await flush();
  }
  async function click(text: string) {
    const button = [...document.querySelectorAll("button")].find(
      (el) => el.textContent === text,
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    await flush();
  }
  async function fill(label: string, value: string) {
    const wrapper = [...document.querySelectorAll("label")].find((el) =>
      el.textContent?.startsWith(label),
    );
    const element =
      wrapper?.querySelector("input") ??
      wrapper?.querySelector("select") ??
      document.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await flush();
  }
  it.each(["secure", "network HTTP"])("records exact dollars with a stable retry identity on %s", async (context) => {
    if (context === "network HTTP") {
      vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    }
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const reportKey = [
      ["finance-summary", "company-one"],
      ["finance-events", "company-one"],
    ];
    const otherKey = [["finance-summary", "company-two"]];
    client.setQueryData(reportKey, {});
    client.setQueryData(otherKey, {});
    await render();
    await click("Record or import charges");
    await fill("Provider or biller", "anthropic");
    await fill("Amount (USD)", "20.123456789");
    await fill("Date (UTC)", "2026-09-01");
    mocks.create.mockRejectedValueOnce(new Error("raw private diagnostic"));
    await submit();
    expect(document.body.textContent).not.toContain("raw private diagnostic");
    const first = mocks.create.mock.calls[0];
    expect(first[0]).toBe("company-one");
    expect(first[1].amountCents).toBe("2012.3456789");
    expect(first[1].idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await submit();
    expect(mocks.create.mock.calls[1]).toEqual(first);
    expect(invalidated).toHaveBeenCalled();
    expect(client.getQueryState(reportKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
    expect(document.querySelector("form")).toBeNull();
    await click("Record or import charges");
    await fill("Amount (USD)", "1");
    await submit();
    expect(mocks.create.mock.calls[2][1].idempotencyKey).not.toBe(first[1].idempotencyKey);
  });
  it("keeps an uncertain submitted charge immutable across close and reopen until confirmed", async () => {
    await render(); await click("Record or import charges");
    await fill("Provider or biller", "anthropic"); await fill("Amount (USD)", "2");
    mocks.create.mockRejectedValueOnce(new Error("Response lost after commit"));
    await submit();
    const original = mocks.create.mock.calls[0];
    expect(document.body.textContent).toContain("This charge may already be saved");
    expect([...document.querySelectorAll<HTMLInputElement>("form input")].every(input => input.disabled)).toBe(true);
    await click("Cancel"); await click("Record or import charges");
    expect(document.body.textContent).toContain("Confirm original charge");
    expect([...document.querySelectorAll<HTMLInputElement>("form input")].every(input => input.disabled)).toBe(true);
    await click("Confirm original charge");
    expect(mocks.create.mock.calls[1]).toEqual(original);
    await click("Record or import charges");
    expect([...document.querySelectorAll<HTMLInputElement>("form input")].every(input => !input.disabled)).toBe(true);
    await fill("Amount (USD)", "3"); await submit();
    expect(mocks.create.mock.calls[2][1].amountCents).toBe("300.0000000");
    expect(mocks.create.mock.calls[2][1].idempotencyKey).not.toBe(original[1].idempotencyKey);
  });

  it("validates invoice input and sends the normalized invoice to the current company", async () => {
    await render();
    await click("Record or import charges");
    await click("Import invoice");
    await fill("Financial invoice JSON", "not json");
    await submit();
    expect(mocks.invoice).not.toHaveBeenCalled();
    await fill(
      "Financial invoice JSON",
      JSON.stringify({
        biller: "openai",
        externalId: "inv",
        currency: "USD",
        lines: [
          {
            externalId: "fee",
            kind: "fee",
            amountCents: "2000",
            occurredAt: "2026-09-01T00:00:00Z",
          },
        ],
      }),
    );
    await submit();
    expect(mocks.invoice).toHaveBeenCalledWith(
      "company-one",
      expect.objectContaining({ externalId: "inv" }),
    );
  });
  it("imports a provider report using only a company secret and explicit workspace scope", async () => {
    const secretId = "00000000-0000-4000-8000-000000000001";
    mocks.secrets.mockResolvedValue([{ id: secretId, name: "Billing admin", scope: "company" }, { id: "private", name: "Private credential", scope: "user" }]);
    await render(); await click("Record or import charges"); await click("Provider report");
    expect(document.body.textContent).not.toContain("Private credential");
    await submit(); expect(mocks.provider).not.toHaveBeenCalled();
    await fill("Provider", "anthropic");
    await fill("Company admin credential", secretId);
    await fill("Provider organization ID", "org_example");
    await fill("Workspace IDs", "workspace_one, workspace_two");
    await fill("From (UTC)", "2026-09-01");
    await fill("Until (UTC, exclusive)", "2026-09-02");
    await submit();
    expect(mocks.provider).toHaveBeenCalledWith("company-one", { provider: "anthropic", secretId, accountId: "org_example", scopeIds: ["workspace_one", "workspace_two"], from: "2026-09-01", to: "2026-09-02" });
    expect(document.querySelector("form")).toBeNull();
  });
  it("clears an open draft when changing company", async () => {
    await render();
    await click("Record or import charges");
    await fill("Provider or biller", "private-draft");
    await render("company-two");
    expect(document.querySelector("form")).toBeNull();
    await click("Record or import charges");
    expect(document.body.textContent).not.toContain("private-draft");
    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
