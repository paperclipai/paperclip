// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { SkillLineageChip } from "./SkillProvenance";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  flushSync(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  await i18n.changeLanguage("en");
});

describe("SkillLineageChip localization", () => {
  it("preserves the full styled source label, route and query data when switching language", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const original = { sourceType: "github", sourceLocator: "https://github.com/acme/PrivateRepo", sourceRef: "abcdef1234567890" };
    const key = queryKeys.companySkills.detail("company-1", "original-1");
    client.setQueryData(key, original);
    flushSync(() => root?.render(
      <QueryClientProvider client={client}>
        <SkillLineageChip companyId="company-1" forkedFromSkillId="original-1" />
      </QueryClientProvider>,
    ));
    const link = container!.querySelector("a")!;
    const href = link.getAttribute("href");
    const label = "acme/PrivateRepo @ abcdef1";
    expect(link.textContent).toBe(`Forked from ${label}`);
    expect(link.title).toBe(`Forked from ${label}`);
    expect(link.querySelector("span.font-medium.text-foreground")?.textContent).toBe(label);
    flushSync(() => { void i18n.changeLanguage("ru"); });
    expect(link.textContent).toBe(`Ответвление от ${label}`);
    expect(link.querySelector("span.font-medium.text-foreground")?.textContent).toBe(label);
    expect(link.getAttribute("href")).toBe(href);
    expect(client.getQueryData(key)).toBe(original);
  });
});
