// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ArtifactRow } from "./ArtifactRow";
import { ArtifactStackTile } from "./ArtifactTile";
import { IconSheet } from "./ArtifactSheet";
import { workProductStateBadge } from "./WorkProductState";
import { labelOf, type ArtifactSubject } from "./kinds";
import { panelDateLabel, updatedLabel } from "./when";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = new Date("2026-09-28T18:00:00");
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18n.changeLanguage("en");
});

describe("Artifacts V1 mounted localization", () => {
  it.each([[1, "1 артефакт"], [2, "2 артефакта"], [5, "5 артефактов"], [21, "21 артефакт"], [22, "22 артефакта"], [25, "25 артефактов"]])("switches stack counts for %i while keeping the task and destination", async (count, expected) => {
    const title = "Raw task {{title}}";
    await act(async () => root.render(<MemoryRouter><ul><ArtifactStackTile identifier="PAP-42" title={title} count={count}
      updatedAt="2026-09-27T10:00:00" now={NOW} front={{ kind: "file", title: "Raw file" }} to="/artifacts?groupIssueId=raw-id" />
    </ul></MemoryRouter>));
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="artifact-v1-stack-tile"]')!;
    expect(link.getAttribute("aria-label")).toBe(`Open PAP-42 ${title}, ${count} ${count === 1 ? "Artifact" : "Artifacts"}`);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(link.getAttribute("aria-label")).toBe(`Открыть PAP-42 ${title}, ${expected}`);
    expect(link.textContent).toContain("Изменено: Вчера");
    expect(link.textContent).toContain(title);
    expect(link.getAttribute("href")).toBe("/artifacts?groupIssueId=raw-id");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(link.textContent).toContain("Updated Yesterday");
    expect(link.getAttribute("href")).toBe("/artifacts?groupIssueId=raw-id");
  });

  it("updates generic kinds, byte units, and dates from a stable subject without translating extensions or user labels", async () => {
    const subject: ArtifactSubject = { kind: "file", title: "Raw title {{name}}", sizeBytes: 59085, sizeLabel: "57.7 KB", updatedAt: "2026-09-25T08:00:00" };
    const before = JSON.stringify(subject);
    await act(async () => root.render(<><ArtifactRow subject={subject} href="/raw/path" now={NOW} /><IconSheet subject={subject} /><ArtifactRow subject={{ ...subject, sizeBytes: undefined, sizeLabel: "Raw external size" }} now={NOW} /></>));
    expect(container.textContent).toContain("57.7 KB");
    expect(container.textContent).toContain("3D ago");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("57,7 КБ");
    expect(container.textContent).toContain("3 дня назад");
    expect(container.textContent).toContain("ФАЙЛ");
    expect(container.textContent).toContain("Raw external size");
    expect(container.textContent).toContain(subject.title);
    expect(labelOf({ kind: "file", title: "Raw", filename: "file.CUSTOM" })).toBe("CUSTOM");
    expect(labelOf({ kind: "pdf", title: "Raw" })).toBe("PDF");
    expect(labelOf({ kind: "link", title: "Raw" })).toBe("URL");
    expect(updatedLabel("2026-09-28T16:05:00", NOW)).toBe("16:05");
    expect(updatedLabel("2026-09-23T09:00:00", NOW)).toBe("среда");
    expect(panelDateLabel("2026-09-28T08:00:00", NOW)).toBe("Сегодня");
    expect(panelDateLabel("2026-09-26T08:00:00", NOW)).toBe("2 дня назад");
    expect(panelDateLabel("2026-09-23T08:00:00", NOW)).toBe("5 дней назад");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("57.7 KB");
    expect(container.textContent).toContain("FILE");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/raw/path");
    expect(JSON.stringify(subject)).toBe(before);
  });

  it("updates unhealthy status without overwriting a caller's label or introducing badges for resting work products", async () => {
    const unhealthy = { type: "runtime_service" as const, status: "active" as const, reviewState: "none" as const, healthStatus: "unhealthy" as const };
    const healthy = { ...unhealthy, healthStatus: "healthy" as const };
    expect(workProductStateBadge({ ...healthy, status: "done" })).toBeUndefined();
    await act(async () => root.render(<>{workProductStateBadge(unhealthy)}{workProductStateBadge(healthy, "Raw supplied label")}</>));
    expect(container.textContent).toContain("Unhealthy");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Неисправен");
    expect(container.textContent).toContain("Raw supplied label");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Unhealthy");
  });
});
