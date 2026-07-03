import { readFileSync } from "node:fs";

const PAPERCLIP_API = process.env.PAPERCLIP_API ?? "http://localhost:3100";

/**
 * Attach a local file to an existing issue comment.
 * The file's first 500 chars are sent as a preview, readable in-thread.
 */
export async function attachFileToComment(
  commentId: string,
  localPath: string,
  label?: string,
): Promise<void> {
  let preview: string | undefined;
  try {
    preview = readFileSync(localPath, "utf8").slice(0, 500);
  } catch {
    // binary or missing — no preview
  }
  const attachment = {
    kind: "local_file" as const,
    path: localPath,
    label,
    preview,
  };
  const res = await fetch(`${PAPERCLIP_API}/api/issue-comments/${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attachments: [attachment] }),
  });
  if (!res.ok) throw new Error(`attachFileToComment failed: ${res.status} ${await res.text()}`);
}
