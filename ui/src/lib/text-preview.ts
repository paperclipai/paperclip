export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export async function readTextPreview(response: Response) {
  if (!response.ok) throw Object.assign(new Error(`Could not load file (${response.status}).`), { status: response.status });
  if (!response.body) throw new Error("The file response is empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TEXT_PREVIEW_MAX_BYTES) throw new Error("This file is too large to preview. Download it instead.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (text.includes("\0")) throw new Error("This file contains binary data. Download it instead.");
    return text;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function loadAttachmentText(contentPath: string, signal?: AbortSignal) {
  if (!/^\/api\/attachments\/[a-zA-Z0-9-]+\/content$/.test(contentPath)) {
    throw new Error("File preview is unavailable. Download the file to view it.");
  }
  return readTextPreview(await fetch(contentPath, { credentials: "same-origin", redirect: "error", signal }));
}
