// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { describeUiError, uiErrorDescriptor } from "@/lib/localized-ui-error";
import { readTextPreview, TEXT_PREVIEW_MAX_BYTES } from "./task-side-panel/TaskAttachmentPanel";
import { readBoardSendDraft } from "./chat/board-send-draft";
afterEach(async()=>{sessionStorage.clear();await i18n.changeLanguage("en");});
it("localizes held first-party file failures by provenance without changing their original Error data or unknown collisions",async()=>{
 const cases=[
  {response:new Response(null),en:"The file response is empty.",zh:"文件响应为空。"},
  {response:new Response("text\0binary"),en:"This file contains binary data. Download it instead.",zh:"此文件包含二进制数据。请下载后查看。"},
  {response:new Response("x".repeat(TEXT_PREVIEW_MAX_BYTES+1)),en:"This file is too large to preview. Download it instead.",zh:"此文件过大，无法预览。请下载后查看。"},
 ];
 for(const row of cases){let cause:unknown;try{await readTextPreview(row.response);}catch(error){cause=error;}expect(cause).toBeInstanceOf(Error);const error=cause as Error,stack=error.stack;expect(error.message).toBe(row.en);expect(uiErrorDescriptor(error)).toBeDefined();await i18n.changeLanguage("zh-CN");expect(describeUiError(error).body).toBe(row.zh);expect(error.message).toBe(row.en);expect(error.stack).toBe(stack);expect(describeUiError(new Error(row.en)).body).toBe(row.en);await i18n.changeLanguage("en");expect(describeUiError(error).body).toBe(row.en);}
});
it("keeps retained-send storage failures English internally while translating their display on demand",async()=>{
 sessionStorage.setItem("invalid-send","{}");let error:unknown;try{readBoardSendDraft("invalid-send");}catch(cause){error=cause;}expect(error).toBeInstanceOf(Error);const original=(error as Error).message;await i18n.changeLanguage("zh-CN");expect(describeUiError(error).body).toBe("无法读取已保存的渠道交付身份标识。请先检查动态，再发起新的发送。");expect((error as Error).message).toBe(original);expect(sessionStorage.getItem("invalid-send")).toBe("{}");
});
