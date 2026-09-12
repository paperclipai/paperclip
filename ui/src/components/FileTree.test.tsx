// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, buildFileTree, FRONTMATTER_FIELD_LABELS, parseFrontmatter } from "./FileTree";
import { i18n, t } from "@/i18n";
import { EXPORT_CATEGORY_LABELS } from "../lib/company-export-selection";
import { formatMegabytes } from "../lib/import-preflight";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("FileTree", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    void i18n.changeLanguage("en");
  });

  function row(path: string) {
    return container.querySelector(`[data-file-tree-path="${path}"]`) as HTMLDivElement | null;
  }

  it("updates Russian file controls live while preserving paths and frontmatter values", () => {
    const contents = "---\nname: Demo Company\nstatus: in_progress\n---\n# Original instructions\n";
    const nodes = buildFileTree({ "agents/AGENT.md": contents });
    const onToggleDir = vi.fn();
    act(() => {
      root.render(<FileTree nodes={nodes} selectedFile={null} expandedDirs={new Set()} onSelectFile={() => {}} onToggleDir={onToggleDir} />);
    });
    expect(container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Files");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Файлы");
    expect(row("agents")?.querySelector("button")?.getAttribute("aria-label")).toBe("Развернуть agents");
    expect(EXPORT_CATEGORY_LABELS.agents).toBe("Агенты");
    expect(FRONTMATTER_FIELD_LABELS.status).toBe("Статус");
    expect(parseFrontmatter(contents)).toEqual({ data: { name: "Demo Company", status: "in_progress" }, body: "# Original instructions\n" });
    expect(formatMegabytes(2 * 1024 * 1024)).toBe("2 МБ");
    act(() => { row("agents")?.querySelector("button")?.click(); });
    expect(onToggleDir).toHaveBeenCalledWith("agents");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Files");
    expect(EXPORT_CATEGORY_LABELS.agents).toBe("Agents");
    expect(formatMegabytes(2 * 1024 * 1024)).toBe("2 MB");
  });

  it.each([[1, "файл"], [2, "файла"], [5, "файлов"], [21, "файл"], [22, "файла"], [25, "файлов"]])(
    "uses full Russian import and export count forms for %i", (count, noun) => {
      void i18n.changeLanguage("ru");
      expect(t("localizationProjects.exportFiles", { count })).toBe(`Экспортировать ${count} ${noun}`);
      expect(t("localizationProjects.importFiles", { count })).toBe(`Импортировать ${count} ${noun}`);
    },
  );

  it("selects file rows and expands directory rows", () => {
    const onSelectFile = vi.fn();
    const onToggleDir = vi.fn();
    const nodes = buildFileTree({
      "README.md": "",
      "docs/guide.md": "",
    });

    act(() => {
      root.render(
        <FileTree
          nodes={nodes}
          selectedFile="README.md"
          expandedDirs={new Set(["docs"])}
          onSelectFile={onSelectFile}
          onToggleDir={onToggleDir}
        />,
      );
    });

    expect(row("README.md")?.getAttribute("aria-selected")).toBe("true");

    act(() => {
      row("docs/guide.md")?.click();
    });
    expect(onSelectFile).toHaveBeenCalledWith("docs/guide.md");

    act(() => {
      row("docs")?.click();
    });
    expect(onToggleDir).toHaveBeenCalledWith("docs");
  });

  it("marks partially selected directories as indeterminate", () => {
    const nodes = buildFileTree({
      "docs/a.md": "",
      "docs/b.md": "",
    });

    act(() => {
      root.render(
        <FileTree
          nodes={nodes}
          selectedFile={null}
          expandedDirs={new Set(["docs"])}
          checkedFiles={new Set(["docs/a.md"])}
          onSelectFile={() => {}}
          onToggleDir={() => {}}
          onToggleCheck={() => {}}
        />,
      );
    });

    const input = row("docs")?.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(input?.checked).toBe(false);
    expect(input?.indeterminate).toBe(true);
    expect(row("docs")?.getAttribute("aria-checked")).toBe("mixed");
  });

  it("renders file badges and host-only file extras", () => {
    const nodes = buildFileTree({
      "wiki/very-long-page-slug.md": "",
    });

    act(() => {
      root.render(
        <FileTree
          nodes={nodes}
          selectedFile={null}
          expandedDirs={new Set(["wiki"])}
          onSelectFile={() => {}}
          onToggleDir={() => {}}
          fileBadges={{
            "wiki/very-long-page-slug.md": {
              label: "fresh",
              status: "ok",
              tooltip: "Synced",
            },
          }}
          renderFileExtra={(node) => (
            node.kind === "file" ? <span data-testid="file-extra">{node.name.length} chars</span> : null
          )}
        />,
      );
    });

    expect(container.textContent).toContain("fresh");
    expect(container.querySelector("[title='Synced']")).not.toBeNull();
    expect(container.querySelector("[data-testid='file-extra']")?.textContent).toBe("22 chars");
  });

  it("wraps long labels by default and can opt back into truncation", () => {
    const nodes = buildFileTree({
      "wiki/extremely-long-page-slug-that-wraps-on-mobile.md": "",
    });

    act(() => {
      root.render(
        <FileTree
          nodes={nodes}
          selectedFile={null}
          expandedDirs={new Set(["wiki"])}
          onSelectFile={() => {}}
          onToggleDir={() => {}}
        />,
      );
    });

    expect(row("wiki/extremely-long-page-slug-that-wraps-on-mobile.md")?.innerHTML).toContain("break-all");

    act(() => {
      root.render(
        <FileTree
          nodes={nodes}
          selectedFile={null}
          expandedDirs={new Set(["wiki"])}
          onSelectFile={() => {}}
          onToggleDir={() => {}}
          wrapLabels={false}
        />,
      );
    });

    expect(row("wiki/extremely-long-page-slug-that-wraps-on-mobile.md")?.innerHTML).toContain("truncate");
  });

  it("supports tree keyboard expansion and checkbox toggling", () => {
    const onToggleDir = vi.fn();
    const onToggleCheck = vi.fn();
    const nodes = buildFileTree({
      "docs/a.md": "",
    });

    act(() => {
      root.render(
        <FileTree
          nodes={nodes}
          selectedFile={null}
          expandedDirs={new Set()}
          onSelectFile={() => {}}
          onToggleDir={onToggleDir}
          onToggleCheck={onToggleCheck}
        />,
      );
    });

    const docsRow = row("docs");
    act(() => {
      docsRow?.focus();
      docsRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onToggleDir).toHaveBeenCalledWith("docs");

    act(() => {
      docsRow?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onToggleCheck).toHaveBeenCalledWith("docs", "dir");
  });
});
