import { localizeUiError } from "@/lib/localized-ui-error";

export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export async function readTextPreview(response: Response) {
  if (!response.ok) throw Object.assign(localizeUiError(new Error(`Could not load file (${response.status}).`), { key: "final-components-b:error.Could_not_load_file_status_cd4474", values: { status: response.status } }), { status: response.status });
  if (!response.body) throw localizeUiError(new Error("The file response is empty."), { key: "final-components-b:error.The_file_response_is_empty_5a3162" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TEXT_PREVIEW_MAX_BYTES) throw localizeUiError(new Error("This file is too large to preview. Download it instead."), { key: "final-components-b:error.This_file_is_too_large_to_preview_Download_it_instead_7731ca" });
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (text.includes("\0")) throw localizeUiError(new Error("This file contains binary data. Download it instead."), { key: "final-components-b:error.This_file_contains_binary_data_Download_it_instead_7e7a9a" });
    return text;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function loadAttachmentText(contentPath: string, signal?: AbortSignal) {
  if (!/^\/api\/attachments\/[a-zA-Z0-9-]+\/content$/.test(contentPath)) {
    throw localizeUiError(new Error("File preview is unavailable. Download the file to view it."), { key: "task-components:filePreviewUnavailable" });
  }
  return readTextPreview(await fetch(contentPath, { credentials: "same-origin", redirect: "error", signal }));
}
