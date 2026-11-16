import type { WorkspaceFileContent } from "@paperclipai/shared";

export const patchText = `diff --git a/ui/src/preview.ts b/ui/src/preview.ts
index 1a2b3c4..5d6e7f8 100644
--- a/ui/src/preview.ts
+++ b/ui/src/preview.ts
@@ -1,3 +1,4 @@
 export function preview() {
-  return "${"old_preview_".repeat(24)}";
+  const label = "${"new_preview_".repeat(24)}";
+  return label;
 }
diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,2 +1,2 @@
--- old comment
+++ new comment
-<script>alert("old")</script>
+<script>alert("new")</script>
\\ No newline at end of file
`;

export const patchMarkdown = `# Preview layout fix\n\nKeep long lines inside the document.\n\n\`\`\`diff\n${patchText}\`\`\`\n`;

export const patchContent: WorkspaceFileContent = {
  resource: {
    kind: "file", provider: "git_worktree", title: "preview-layout.patch",
    displayPath: "patches/preview-layout.patch", workspaceLabel: "Preview workspace",
    workspaceKind: "execution_workspace", workspaceId: "patch-story-workspace",
    contentType: "text/x-patch", byteSize: patchText.length, previewKind: "text",
    capabilities: { preview: true, download: true, listChildren: false },
  },
  content: { encoding: "utf8", data: patchText },
};
