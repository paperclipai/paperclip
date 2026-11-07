// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactFileRow } from "./artifacts/v1/ArtifactFileRow";
import { testSubject } from "./artifacts/v1/test-subject";
import { IssueArtifactFile } from "./artifacts/IssueArtifactCard";
import * as data from "@/lib/artifact-card-data";
import { i18n } from "@/i18n";
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await act(async () => { await i18n.changeLanguage("en"); }); });
it.each(["row", "issue"])("keeps the %s artifact preview failure live and raw manual collisions untouched", async kind => {
  let original!: Error; try { data.parseArtifactCsv('"incomplete'); } catch (error) { original = error as Error; }
  const load = vi.spyOn(data, "loadArtifactCsv").mockRejectedValue(original);
  const props = { id: "csv-id", filename: "raw.csv", contentType: "text/csv", contentPath: "/api/attachments/csv-id/content", openPath: "/api/attachments/csv-id/content?inline=1", downloadPath: "/api/attachments/csv-id/content?download=1", byteSize: 20 };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = kind === "row" ? <ArtifactFileRow subject={testSubject({ kind: "sheet", filename: "raw.csv" })} source={props} /> : <IssueArtifactFile {...props} title="raw title" summary="" author="raw author" updatedAt="raw date" />;
  try {
    await act(async () => { await i18n.changeLanguage("en"); root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>); });
    const preview = [...host.querySelectorAll("button")].find(b => b.textContent === "Preview data"); expect(preview).toBeDefined(); await act(async () => { preview!.click(); });
    for (let n = 0; n < 20 && !host.textContent?.includes(original.message); n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain(original.message);
    await act(async () => { await i18n.changeLanguage("zh-CN"); }); expect(host.textContent).toContain("无法预览 CSV。请下载文件查看。");
    await act(async () => { await i18n.changeLanguage("en"); }); expect(host.textContent).toContain(original.message); expect(load).toHaveBeenCalledOnce();
    const raw = new Error(original.message, { cause: "vendor cause" }); const before = Object.getOwnPropertyDescriptors(raw); load.mockRejectedValue(raw);
    const retry = [...host.querySelectorAll("button")].find(b => /retry|try again/i.test(b.textContent ?? "")); expect(retry).toBeDefined(); await act(async () => { retry!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); await i18n.changeLanguage("zh-CN"); });
    expect(host.textContent).toContain(raw.message); expect(Object.getOwnPropertyDescriptors(raw)).toEqual(before); expect(host.querySelector('a[download="raw.csv"]')?.getAttribute("href")).toContain("download=1");
  } finally { await act(async () => root.unmount()); client.clear(); host.remove(); }
});
