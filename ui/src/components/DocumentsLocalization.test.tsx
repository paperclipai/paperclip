// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileContent } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { FileContentViewer, FileViewerMetadataRow, describeDenial } from "./FileViewerSheet";
import { FrontmatterPanel } from "./FrontmatterPanel";

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
describe("Document localization", () => {
  it.each([
    [1, "1 материал", "Файл загружен: 1 строка."],
    [2, "2 материала", "Файл загружен: 2 строки."],
    [5, "5 материалов", "Файл загружен: 5 строк."],
    [21, "21 материал", "Файл загружен: 21 строка."],
    [22, "22 материала", "Файл загружен: 22 строки."],
    [25, "25 материалов", "Файл загружен: 25 строк."],
  ])("uses Russian material and loaded-file count forms for %i", async (count, materials, loaded) => {
    await i18n.changeLanguage("ru");
    expect(t("pages.cases.caseCount", { count })).toBe(materials);
    expect(t("localizationDocuments.fileLoaded", { count })).toBe(loaded);
  });

  it("switches the mounted YAML editor without emitting changes or modifying raw bytes", async () => {
    mount();
    const raw = "name: example # retain this comment\ndescription: User text\nallowed-tools: [Read, Grep]\nmetadata:\n  version: 2";
    const onChange = vi.fn();
    await act(async () => root?.render(<FrontmatterPanel frontmatterText={raw} hasFrontmatter fileName="SKILL.md" onChange={onChange} />));
    await act(async () => container?.querySelector<HTMLButtonElement>('button[aria-controls="frontmatter-panel-body"]')?.click());
    expect(container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Frontmatter YAML"]')?.value).toBe(raw);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container?.textContent).toContain("Метаданные документа");
    expect(container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Метаданные в YAML"]')?.value).toBe(raw);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Frontmatter YAML"]')?.value).toBe(raw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates mounted file preview controls and announcements while retaining file content and identifiers", async () => {
    mount();
    const content: WorkspaceFileContent = {
      resource: { kind: "file", provider: "local_fs", title: "README.md", displayPath: "docs/README.md", workspaceLabel: "User workspace", workspaceKind: "project_workspace", workspaceId: "raw-workspace", contentType: "text/markdown; charset=utf-8", byteSize: 22, previewKind: "text", capabilities: { preview: true, download: true, listChildren: false } },
      content: { encoding: "utf8", data: "# User heading\n\nRAW_MARKDOWN" },
    };
    const before = JSON.stringify(content);
    const onLoaded = vi.fn();
    await act(async () => root?.render(<ThemeProvider><FileViewerMetadataRow resolvedResource={content.resource} state={null} /><FileContentViewer content={content} highlightedLine={null} onLoaded={onLoaded} /></ThemeProvider>));
    expect(container?.querySelector('button[aria-label="Show raw Markdown"]')).not.toBeNull();
    expect(container?.textContent).toContain("User heading");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container?.querySelector('button[aria-label="Показать исходный Markdown"]')).not.toBeNull();
    expect(container?.textContent).toContain("User heading");
    expect(onLoaded).toHaveBeenLastCalledWith("Файл загружен: 3 строки.");
    await act(async () => container?.querySelector<HTMLButtonElement>('button[aria-label="Показать исходный Markdown"]')?.click());
    expect(container?.textContent).toContain("# User heading");
    expect(container?.textContent).toContain("RAW_MARKDOWN");
    expect(describeDenial("outside_workspace_root", "RAW_ERROR").title).toBe("Путь находится вне рабочей области");
    expect(describeDenial("vendor_unknown", "RAW_ERROR").body).toBe("RAW_ERROR");
    expect(JSON.stringify(content)).toBe(before);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container?.querySelector('button[aria-label="Show raw Markdown"][aria-pressed="true"]')).not.toBeNull();
    expect(container?.textContent).toContain("# User heading");
    expect(JSON.stringify(content)).toBe(before);
  });
});
