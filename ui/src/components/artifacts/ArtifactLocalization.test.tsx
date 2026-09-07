// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyArtifact, CompanyArtifactGroup } from "@/api/artifacts";
import { i18n } from "@/i18n";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactGroupCard } from "./ArtifactGroupCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, disableIssueQuicklook: _disableIssueQuicklook, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; disableIssueQuicklook?: boolean }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  await i18n.changeLanguage("en");
});
function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}
const artifact: CompanyArtifact = {
  id: "raw-artifact-1", source: "document", mediaKind: "document", title: "User title",
  previewText: "# User Markdown\nRAW_PREVIEW", contentType: "text/markdown", contentPath: null,
  openPath: "/files/raw-1.md", downloadPath: "/files/raw-1.md?download=1",
  issue: { id: "raw-issue-1", identifier: "PAP-42", title: "User issue" }, project: null,
  createdByAgent: { id: "raw-agent-1", name: "User agent" },
  updatedAt: new Date(2026, 5, 1, 12).toISOString(), href: "/issues/PAP-42#raw-artifact-1",
};

describe("Artifact localization", () => {
  it("switches card controls and dates without rewriting user text or file destinations", async () => {
    mount();
    const before = JSON.stringify(artifact);
    await act(async () => root?.render(<ArtifactCard artifact={artifact} />));
    expect(container?.textContent).toContain("Last edited Jun 1, 2026");
    const openLink = container?.querySelector('a[aria-label="Open file in new tab"]');
    const downloadLink = container?.querySelector('a[aria-label="Download file"]');
    expect(openLink?.getAttribute("href")).toBe(artifact.openPath);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(openLink?.getAttribute("aria-label")).toBe("Открыть файл в новой вкладке");
    expect(downloadLink?.getAttribute("aria-label")).toBe("Скачать файл");
    expect(downloadLink?.getAttribute("href")).toBe(artifact.downloadPath);
    expect(container?.textContent).toContain("Изменено 1 июн. 2026 г.");
    expect(container?.textContent).toContain(artifact.previewText);
    expect(container?.textContent).toContain("User title");
    expect(container?.textContent).toContain("User agent");
    expect(container?.querySelector('[data-testid="artifact-card"]')?.getAttribute("href")).toBe(artifact.href);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(openLink?.getAttribute("aria-label")).toBe("Open file in new tab");
    expect(JSON.stringify(artifact)).toBe(before);
  });

  it.each([[1, "1 артефакт"], [2, "2 артефакта"], [5, "5 артефактов"], [21, "21 артефакт"], [22, "22 артефакта"], [25, "25 артефактов"]])("updates mounted group counts for %i without changing grouping or routes", async (count, expected) => {
    mount();
    const group: CompanyArtifactGroup = { id: "task:raw-issue-1", groupBy: "task", issue: artifact.issue, title: "User group", count, mediaKinds: ["document"], previewArtifacts: [artifact], updatedAt: artifact.updatedAt, href: "/artifacts?groupBy=task&groupIssueId=raw-issue-1" };
    const before = JSON.stringify(group);
    await act(async () => root?.render(<ArtifactGroupCard group={group} to={group.href} />));
    const card = container?.querySelector('[data-testid="artifact-group-card"]');
    expect(card?.getAttribute("title")).toBe(`${count} artifact${count === 1 ? "" : "s"}`);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(card?.getAttribute("title")).toBe(expected);
    expect(card?.textContent).toContain(expected);
    expect(card?.getAttribute("data-group-id")).toBe(group.id);
    expect(card?.getAttribute("data-count")).toBe(String(count));
    expect(card?.getAttribute("href")).toBe(group.href);
    expect(card?.textContent).toContain("User group");
    expect(card?.textContent).toContain("PAP-42");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(card?.getAttribute("title")).toBe(`${count} artifact${count === 1 ? "" : "s"}`);
    expect(JSON.stringify(group)).toBe(before);
  });
});
