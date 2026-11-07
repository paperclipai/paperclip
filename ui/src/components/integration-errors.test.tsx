// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { CsvPreview } from "./CsvPreview";
import { parseCsv } from "@/lib/csv-preview";
import { parseArtifactCsv } from "@/lib/artifact-card-data";
import { describeUiError, uiErrorDescriptor } from "@/lib/localized-ui-error";
import { i18n } from "@/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await i18n.changeLanguage("en"); });

it("keeps a memoized parser failure live across en/zh/en without translating data or manual collisions", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const source = '"provider payload';
  let original!: Error;
  try { parseCsv(source); } catch (error) { original = error as Error; }
  const before = Object.getOwnPropertyDescriptors(original);
  await act(async () => { await i18n.changeLanguage("en"); root.render(<CsvPreview text={source} title="user title" />); });
  expect(host.textContent).toContain(original.message);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain("引号字段不完整。切换到原始视图以检查文件。");
  expect(uiErrorDescriptor(original)).toBeDefined();
  expect(describeUiError(new Error(original.message)).body).toBe(original.message);
  expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(host.textContent).toContain(original.message);
  await act(async () => root.unmount()); host.remove();
});

it("tags only parser-owned artifact failures, never matching raw error text", async () => {
  let original!: Error;
  try { parseArtifactCsv('"unterminated'); } catch (error) { original = error as Error; }
  const before = Object.getOwnPropertyDescriptors(original);
  await i18n.changeLanguage("zh-CN");
  expect(describeUiError(original).body).toBe("无法预览 CSV。请下载文件查看。");
  expect(describeUiError(new Error(original.message)).body).toBe(original.message);
  expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
  expect(parseArtifactCsv('name\n"无法预览 CSV。请下载文件查看。"').rows).toEqual([["无法预览 CSV。请下载文件查看。"]]);
});
