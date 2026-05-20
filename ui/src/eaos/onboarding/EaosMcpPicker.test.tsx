// @vitest-environment jsdom
//
// LET-515 — frontend tests for the canonical MCP catalog picker.
//
// The picker has three contract points the tests assert:
//   1) Catalog allowlist surface — list view only renders entries the server
//      returned (server filters non-allowlisted out, but the picker must also
//      pass them straight through without re-routing).
//   2) Preview-only behaviour — selecting an entry calls the preview endpoint
//      with the chosen catalogId; the response is rendered as blockers +
//      missing-refs + tool list, with no apply CTA.
//   3) Secret-reference validation — the picker rejects raw-secret-shaped
//      pastes client-side, never echoes them in the DOM, and only sends
//      well-formed env-style names to the network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const companiesRef: { current: { id: string; name: string }[] } = {
  current: [{ id: "company-1", name: "Acme" }],
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companiesRef.current,
    selectedCompany: companiesRef.current[0] ?? null,
    selectedCompanyId: companiesRef.current[0]?.id ?? null,
    loading: false,
    createCompany: vi.fn(),
  }),
}));

import { EaosMcpPicker } from "./EaosMcpPicker";
import type {
  McpCatalogListEntry,
  McpCatalogPreviewResult,
} from "@/api/mcpCatalog";

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

const VERIFIED_GITHUB_ENTRY: McpCatalogListEntry = {
  catalogId: "verified/github-readonly",
  server: {
    provider: "official_registry",
    catalogId: "verified/github-readonly",
    name: "GitHub (read-only)",
    title: "GitHub (read-only)",
    description: "Read-only GitHub surface.",
    version: null,
    transport: "stdio",
    command: null,
    remoteUrl: null,
    sourceUrl: null,
    license: "MIT",
    requiredSecretNames: ["GITHUB_TOKEN"],
    requiredOptionalEnvNames: [],
    toolNames: ["github.get_repo", "github.list_issues"],
    trust: { verifiedPublisher: true, sourceAvailable: true, containerized: false },
  },
  preview: {
    server: {
      provider: "official_registry",
      catalogId: "verified/github-readonly",
      name: "GitHub (read-only)",
      title: "GitHub (read-only)",
      description: "Read-only GitHub surface.",
      version: null,
      transport: "stdio",
      command: null,
      remoteUrl: null,
      sourceUrl: null,
      license: "MIT",
      requiredSecretNames: ["GITHUB_TOKEN"],
      requiredOptionalEnvNames: [],
      toolNames: ["github.get_repo", "github.list_issues"],
      trust: { verifiedPublisher: true, sourceAvailable: true, containerized: false },
    },
    action: "allow_readonly_preview",
    requiresApproval: false,
    blockers: [],
    envTemplate: { GITHUB_TOKEN: "[REQUIRED_SECRET:GITHUB_TOKEN]" },
    toolPolicies: [],
  },
};

const VERIFIED_FS_ENTRY: McpCatalogListEntry = {
  catalogId: "verified/filesystem-readonly",
  server: {
    provider: "official_registry",
    catalogId: "verified/filesystem-readonly",
    name: "Filesystem (read-only)",
    title: "Filesystem (read-only)",
    description: "Read-only filesystem surface.",
    version: null,
    transport: "stdio",
    command: null,
    remoteUrl: null,
    sourceUrl: null,
    license: "MIT",
    requiredSecretNames: [],
    requiredOptionalEnvNames: [],
    toolNames: ["fs.read_file"],
    trust: { verifiedPublisher: true, sourceAvailable: true, containerized: false },
  },
  preview: {
    server: {
      provider: "official_registry",
      catalogId: "verified/filesystem-readonly",
      name: "Filesystem (read-only)",
      title: "Filesystem (read-only)",
      description: "Read-only filesystem surface.",
      version: null,
      transport: "stdio",
      command: null,
      remoteUrl: null,
      sourceUrl: null,
      license: "MIT",
      requiredSecretNames: [],
      requiredOptionalEnvNames: [],
      toolNames: ["fs.read_file"],
      trust: { verifiedPublisher: true, sourceAvailable: true, containerized: false },
    },
    action: "allow_readonly_preview",
    requiresApproval: false,
    blockers: [],
    envTemplate: {},
    toolPolicies: [],
  },
};

beforeEach(() => {
  companiesRef.current = [{ id: "company-1", name: "Acme" }];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function setReactInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

interface RenderOpts {
  fetchList?: (companyId: string) => Promise<{ entries: ReadonlyArray<McpCatalogListEntry> }>;
  previewInstall?: (
    companyId: string,
    body: { catalogId: string; namedSecretRefs?: string[] },
  ) => Promise<McpCatalogPreviewResult>;
}

async function renderPicker(opts: RenderOpts = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <EaosMcpPicker
          fetchList={opts.fetchList}
          previewInstall={opts.previewInstall}
        />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("EaosMcpPicker (LET-515)", () => {
  it("renders only the entries returned by the catalog list endpoint", async () => {
    const fetchList = vi.fn(async () => ({
      entries: [VERIFIED_GITHUB_ENTRY, VERIFIED_FS_ENTRY],
    }));
    await renderPicker({ fetchList });
    await waitForAssertion(() => {
      const entries = Array.from(
        container?.querySelectorAll('[data-testid="eaos-onboarding-mcp-picker-entry"]') ?? [],
      ) as HTMLElement[];
      expect(entries.length).toBe(2);
      const ids = entries.map((entry) => entry.getAttribute("data-catalog-id"));
      expect(ids).toEqual([
        "verified/github-readonly",
        "verified/filesystem-readonly",
      ]);
    });
  });

  it("opens the preview-only panel when an entry is selected and never renders an apply CTA", async () => {
    const fetchList = vi.fn(async () => ({ entries: [VERIFIED_GITHUB_ENTRY] }));
    const previewInstall = vi.fn(async (_companyId: string, body: { catalogId: string }) => ({
      catalogId: body.catalogId,
      server: VERIFIED_GITHUB_ENTRY.server,
      preview: VERIFIED_GITHUB_ENTRY.preview,
      suppliedSecretRefs: [],
      missingRequiredSecretRefs: ["GITHUB_TOKEN"],
      applyPath: "preview_only" as const,
    }));
    await renderPicker({ fetchList, previewInstall });
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-entry"]'),
      ).not.toBeNull();
    });
    const previewBtn = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-entry-preview"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      previewBtn?.click();
    });
    await waitForAssertion(() => {
      expect(previewInstall).toHaveBeenCalledWith("company-1", {
        catalogId: "verified/github-readonly",
        namedSecretRefs: [],
      });
      const panel = container?.querySelector(
        '[data-testid="eaos-onboarding-mcp-picker-preview"]',
      );
      expect(panel).not.toBeNull();
      // The preview banner advertises the no-apply contract.
      const banner = container?.querySelector(
        '[data-testid="eaos-onboarding-mcp-picker-preview-banner"]',
      );
      expect(banner?.textContent ?? "").toContain("Preview only");
      // There is no apply CTA in the picker.
      const buttons = Array.from(container?.querySelectorAll("button") ?? []);
      for (const button of buttons) {
        expect(button.textContent?.toLowerCase() ?? "").not.toContain("apply");
        expect(button.textContent?.toLowerCase() ?? "").not.toContain("install");
      }
    });
  });

  it("staging a well-formed secret reference sends only the name to the network", async () => {
    const fetchList = vi.fn(async () => ({ entries: [VERIFIED_GITHUB_ENTRY] }));
    const previewInstall = vi.fn(async (_companyId: string, body) => ({
      catalogId: body.catalogId,
      server: VERIFIED_GITHUB_ENTRY.server,
      preview: VERIFIED_GITHUB_ENTRY.preview,
      suppliedSecretRefs: body.namedSecretRefs ?? [],
      missingRequiredSecretRefs: (body.namedSecretRefs ?? []).includes("GITHUB_TOKEN")
        ? []
        : ["GITHUB_TOKEN"],
      applyPath: "preview_only" as const,
    }));
    await renderPicker({ fetchList, previewInstall });
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-entry-preview"]'),
      ).not.toBeNull();
    });
    const previewBtn = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-entry-preview"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      previewBtn?.click();
    });
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-secret-input"]'),
      ).not.toBeNull();
    });
    const input = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-secret-input"]',
    ) as HTMLInputElement | null;
    await act(async () => {
      if (input) setReactInputValue(input, "GITHUB_TOKEN");
    });
    const addBtn = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-secret-add"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      addBtn?.click();
    });
    await waitForAssertion(() => {
      const chips = Array.from(
        container?.querySelectorAll('[data-testid="eaos-onboarding-mcp-picker-secret-chip"]') ??
          [],
      );
      expect(chips.length).toBe(1);
      expect(chips[0]?.textContent ?? "").toContain("GITHUB_TOKEN");
      // The preview endpoint was called twice: once on select (empty refs),
      // and again after the chip was added with the supplied ref.
      const refsArg = previewInstall.mock.calls.at(-1)?.[1] as { namedSecretRefs?: string[] };
      expect(refsArg.namedSecretRefs).toEqual(["GITHUB_TOKEN"]);
    });
  });

  it("rejects a raw-secret-looking paste client-side and never sends it to the network", async () => {
    const fetchList = vi.fn(async () => ({ entries: [VERIFIED_GITHUB_ENTRY] }));
    const previewInstall = vi.fn(async (_companyId: string, body) => ({
      catalogId: body.catalogId,
      server: VERIFIED_GITHUB_ENTRY.server,
      preview: VERIFIED_GITHUB_ENTRY.preview,
      suppliedSecretRefs: body.namedSecretRefs ?? [],
      missingRequiredSecretRefs: ["GITHUB_TOKEN"],
      applyPath: "preview_only" as const,
    }));
    await renderPicker({ fetchList, previewInstall });
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-entry-preview"]'),
      ).not.toBeNull();
    });
    const previewBtn = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-entry-preview"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      previewBtn?.click();
    });
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-secret-input"]'),
      ).not.toBeNull();
    });
    // Capture the call count after the initial preview so we can assert the
    // network was not hit again by the raw-secret path.
    const networkCallsBefore = previewInstall.mock.calls.length;

    const RAW_LIKE = "ghp_fakeFakeFakeFakeFakeFakeFakeFAKE";
    const input = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-secret-input"]',
    ) as HTMLInputElement | null;
    await act(async () => {
      if (input) setReactInputValue(input, RAW_LIKE);
    });
    const addBtn = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-secret-add"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      addBtn?.click();
    });
    await waitForAssertion(() => {
      // Network was not called again.
      expect(previewInstall.mock.calls.length).toBe(networkCallsBefore);
      // No chip was added — the rejected paste must not surface in the DOM.
      const chips = Array.from(
        container?.querySelectorAll('[data-testid="eaos-onboarding-mcp-picker-secret-chip"]') ??
          [],
      );
      expect(chips.length).toBe(0);
      // The raw-secret-shaped value must NOT survive into any rendered text.
      const allText = container?.textContent ?? "";
      expect(allText).not.toContain(RAW_LIKE);
      // The error notice is shown.
      const err = container?.querySelector(
        '[data-testid="eaos-onboarding-mcp-picker-preview-error"]',
      );
      expect(err).not.toBeNull();
      expect(err?.textContent ?? "").toMatch(/raw secret|named secret/i);
      // The draft input is wiped so the offending value cannot remain in the DOM.
      const draft = container?.querySelector(
        '[data-testid="eaos-onboarding-mcp-picker-secret-input"]',
      ) as HTMLInputElement | null;
      expect(draft?.value ?? "").toBe("");
    });
  });

  it("never renders a password input, an apply button, or a field whose name suggests it accepts raw secrets", async () => {
    const fetchList = vi.fn(async () => ({ entries: [VERIFIED_GITHUB_ENTRY] }));
    await renderPicker({ fetchList });
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-entry-preview"]'),
      ).not.toBeNull();
    });
    // Open the preview so the secret-ref editor is in the DOM.
    const previewBtn = container?.querySelector(
      '[data-testid="eaos-onboarding-mcp-picker-entry-preview"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      previewBtn?.click();
    });
    await waitForAssertion(() => {
      const inputs = Array.from(container?.querySelectorAll("input") ?? []) as HTMLInputElement[];
      // No password inputs.
      expect(inputs.filter((i) => i.type === "password").length).toBe(0);
      // No autocomplete=on for secret-like fields. The picker explicitly disables
      // autocomplete and spellcheck on the secret-ref input.
      for (const i of inputs) {
        expect(i.autocomplete).toBe("off");
      }
      // No button advertises an apply / install action.
      const buttons = Array.from(container?.querySelectorAll("button") ?? []);
      for (const button of buttons) {
        const text = button.textContent?.toLowerCase() ?? "";
        expect(text).not.toContain("apply now");
        expect(text).not.toContain("install now");
      }
    });
  });

  it("renders a no-company hint when no company is selected", async () => {
    companiesRef.current = [];
    await renderPicker();
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-mcp-picker-no-company"]'),
      ).not.toBeNull();
    });
  });
});
