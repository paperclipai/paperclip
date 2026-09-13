import type { WorkFile, WorkFolderListing, WorkFolderOwner, WorkFolderSyncStatus } from "@paperclipai/shared";
import { api, ApiError } from "./client";

function base(owner: WorkFolderOwner) {
  return `/companies/${encodeURIComponent(owner.companyId)}/work-folders/${owner.scope}/${encodeURIComponent(owner.ownerId)}`;
}
export const workFoldersApi = {
  async list(owner: WorkFolderOwner, trash = false) {
    const files: WorkFile[] = [];
    let cursor: string | null = null;
    let lastOperationAt: string | null = null;
    do {
      const query = new URLSearchParams({ trash: String(trash), limit: "1000", ...(cursor ? { cursor } : {}) });
      const page: WorkFolderListing = await api.get(`${base(owner)}?${query}`);
      files.push(...page.files);
      if (page.lastOperationAt && (!lastOperationAt || page.lastOperationAt > lastOperationAt)) lastOperationAt = page.lastOperationAt;
      cursor = page.nextCursor;
    } while (cursor && files.length < 100_000);
    if (cursor) throw new Error("This folder is too large to display in one view");
    return { files, lastOperationAt };
  },
  upload: (owner: WorkFolderOwner, file: File, filePath: string, operationId: string) =>
    api.putRaw(`${base(owner)}/content?${new URLSearchParams({ path: filePath })}`, file,
      { headers: { "X-File-Content-Type": file.type || "application/octet-stream", "Idempotency-Key": operationId } }),
  operation: (owner: WorkFolderOwner, operation: { action: "mkdir" | "delete"; path: string } | { action: "restore" | "purge"; fileId: string }, operationId: string) =>
    api.post(`${base(owner)}/operations`, operation, { headers: { "Idempotency-Key": operationId } }),
  downloadUrl: (owner: WorkFolderOwner, filePath: string) => `/api${base(owner)}/content?${new URLSearchParams({ path: filePath })}`,
  async preview(owner: WorkFolderOwner, file: WorkFile) {
    if (file.byteSize > 8 * 1024 * 1024) throw new Error("Download this file to view it; previews are limited to 8 MB");
    const response = await fetch(this.downloadUrl(owner, file.path), { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new ApiError("File preview could not be loaded", response.status, null);
    const contentLength = Number(response.headers.get("Content-Length"));
    if (!Number.isFinite(contentLength) || contentLength > 8 * 1024 * 1024) { await response.body?.cancel(); throw new Error("File exceeds preview size limit"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("File preview could not be loaded");
    const parts: ArrayBuffer[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 8 * 1024 * 1024) throw new Error("File exceeds preview size limit");
        parts.push(chunk.value.slice().buffer);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const blob = new Blob(parts, { type: file.contentType });
    const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(file.contentType);
    const text = file.contentType.startsWith("text/") || /\.(md|txt|json|ya?ml|toml|csv|log|[cm]?[jt]sx?|py|sh|rs|go|css|html|xml)$/i.test(file.path) || file.byteSize === 0;
    if (!image && !text) throw new Error("Preview is unavailable for this file type; download it to view it");
    const data = image ? await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error("Preview could not be read"));
      reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.readAsDataURL(blob);
    }) : await blob.text();
    return { resource: { title: file.path.split("/").at(-1)!, displayPath: file.path, contentType: file.contentType,
      previewKind: image ? "image" as const : "text" as const }, content: { encoding: image ? "base64" as const : "utf8" as const, data } };
  },
  sync: (owner: WorkFolderOwner) => api.get<WorkFolderSyncStatus[]>(`${base(owner)}/sync`),
  refresh: (owner: WorkFolderOwner, runId: string) => api.post(`${base(owner)}/refresh`, { runId }),
};
