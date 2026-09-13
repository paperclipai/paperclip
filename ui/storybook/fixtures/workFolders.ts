import type {
  WorkFile,
  WorkFolderOwner,
  WorkFolderScope,
  WorkFolderSyncStatus,
} from "@paperclipai/shared";

export type WorkFolderScenario =
  | "saved"
  | "saving"
  | "failed"
  | "empty"
  | "loading"
  | "unavailable"
  | "uploadFailed";
export const WORK_FOLDER_COMPANY = "company-storybook";
export const workFolderOwners: Record<WorkFolderScope, WorkFolderOwner> = {
  task: {
    companyId: WORK_FOLDER_COMPANY,
    scope: "task",
    ownerId: "issue-storybook-1",
  },
  agent: {
    companyId: WORK_FOLDER_COMPANY,
    scope: "agent",
    ownerId: "agent-codex",
  },
  project: {
    companyId: WORK_FOLDER_COMPANY,
    scope: "project",
    ownerId: "project-board-ui",
  },
  user: {
    companyId: WORK_FOLDER_COMPANY,
    scope: "user",
    ownerId: "user-board",
  },
};
export const workFolderLabels = {
  task: "Task files",
  agent: "Agent files",
  project: "Project files",
  user: "My files",
};
const savedAt = "2026-09-08T14:00:00.000Z";
const updatedAt = "2026-09-08T14:01:00.000Z";

/** A fresh, in-memory API per mounted story. No real files or server are used. */
export function createWorkFolderFixture(
  scenario: WorkFolderScenario = "saved",
) {
  const collections = new Map<
    string,
    { files: WorkFile[]; contents: Map<string, Blob>; changed: boolean }
  >();
  let revision = 0;
  function collection(scope: string, ownerId: string) {
    const key = `${scope}:${ownerId}`;
    const existing = collections.get(key);
    if (existing) return existing;
    const files: WorkFile[] = [];
    const contents = new Map<string, Blob>();
    function add(
      path: string,
      content: string,
      options: Partial<WorkFile> = {},
    ) {
      const blob = new Blob([content], {
        type: options.contentType ?? "text/plain",
      });
      files.push({
        id: `${key}:${path}`,
        path,
        kind: "file",
        byteSize: blob.size,
        sha256: `fixture-${path}`,
        executable: false,
        contentType: blob.type,
        deletedAt: null,
        updatedAt: savedAt,
        ...options,
      });
      contents.set(path, blob);
    }
    if (scenario !== "empty") {
      add(
        "README.md",
        `# ${workFolderLabels[scope as WorkFolderScope]}\n\nFiles available to this ${scope}'s sandbox runs.\n\n## Current work\n\n- Review the launch brief\n- Keep the original uploads\n- Share the final report\n`,
        { contentType: "text/markdown" },
      );
      add(
        "briefs/launch.md",
        "# Launch brief\n\nMake it easy to find, review, and recover the files an agent creates.\n",
        { contentType: "text/markdown" },
      );
      add(
        "reports/findings.json",
        '{\n  "status": "review",\n  "checks": 12,\n  "openQuestions": 2\n}\n',
        { contentType: "application/json" },
      );
      add(
        "scripts/verify.sh",
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf "Ready for review\\n"\n',
        { executable: true },
      );
      add("empty.txt", "");
      add("archive.zip", "Binary archive fixture", {
        contentType: "application/zip",
      });
      add("recording.mp4", "Large file fixture", {
        contentType: "video/mp4",
        byteSize: 12 * 1024 * 1024,
      });
      add(
        "drafts/old-notes.md",
        "Superseded draft; recoverable until purged.",
        { deletedAt: savedAt },
      );
      add(
        "research/customer-interviews/round-two/detailed-feedback-and-next-steps.md",
        "# Interview notes\n\nA deliberately long nested path for layout review.\n",
      );
      add("assets/paperclip.png", "", { contentType: "image/png" });
    }
    const value = { files, contents, changed: false };
    collections.set(key, value);
    return value;
  }
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    // ProjectDetail loads this list even when its Files dialog is the review focus.
    if (
      request.method === "GET" &&
      url.pathname ===
        `/api/companies/${WORK_FOLDER_COMPANY}/execution-workspaces`
    ) {
      return Response.json([]);
    }
    const match = url.pathname.match(
      /^\/api\/companies\/company-storybook\/work-folders\/(task|agent|user|project)\/([^/]+)(?:\/(content|operations|sync|refresh))?$/,
    );
    if (!match) return null;
    const [, scope, ownerId, action] = match;
    const state = collection(scope, decodeURIComponent(ownerId));
    const fail = (message: string, status = 503) =>
      Response.json({ error: message }, { status });
    if (action === "sync") {
      const status: WorkFolderSyncStatus = {
        runId: "run-storybook",
        state:
          scenario === "saving"
            ? "saving"
            : scenario === "failed"
              ? "failed"
              : "saved",
        lastSavedAt: savedAt,
        active: scenario === "saving" || scenario === "failed",
        refreshRequested: false,
        error:
          scenario === "failed"
            ? "Storage is unavailable. Your working files are retained in the sandbox; retry when storage recovers."
            : null,
      };
      return Response.json([status]);
    }
    if (action === "refresh") return Response.json({ ok: true });
    if (!action) {
      if (scenario === "loading")
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      if (scenario === "unavailable")
        return fail(
          "Files could not be loaded. Try again when storage is available.",
        );
      const trash = url.searchParams.get("trash") === "true";
      return Response.json({
        id: `${scope}-${ownerId}`,
        owner: { companyId: WORK_FOLDER_COMPANY, scope, ownerId },
        files: state.files.filter((f) => Boolean(f.deletedAt) === trash),
        nextCursor: null,
        lastOperationAt: state.changed ? updatedAt : null,
      });
    }
    const path = url.searchParams.get("path") ?? "";
    if (action === "content" && request.method === "GET") {
      if (
        !state.files.some((file) => file.path === path && file.kind === "file")
      ) {
        return fail("File not found", 404);
      }
      if (path === "assets/paperclip.png")
        return fetch("/android-chrome-192x192.png", { signal: request.signal });
      const blob = state.contents.get(path);
      return blob
        ? new Response(blob, {
            headers: {
              "Content-Type": blob.type,
              "Content-Length": String(blob.size),
            },
          })
        : fail("File not found", 404);
    }
    if (action === "content" && request.method === "PUT") {
      if (scenario === "uploadFailed")
        return fail(
          "Upload failed: storage is unavailable. Your existing files were not changed.",
        );
      const blob = await request.blob();
      state.contents.set(path, blob);
      state.files = state.files.filter((f) => f.path !== path);
      state.files.push({
        id: `${scope}:${ownerId}:${++revision}`,
        path,
        kind: "file",
        byteSize: blob.size,
        sha256: `uploaded-${revision}`,
        executable: false,
        contentType: request.headers.get("X-File-Content-Type") ?? blob.type,
        deletedAt: null,
        updatedAt,
      });
    } else if (action === "operations") {
      const op = (await request.json()) as {
        action: string;
        path?: string;
        fileId?: string;
      };
      if (op.action === "mkdir")
        state.files.push({
          id: `directory-${++revision}`,
          path: op.path!,
          kind: "directory",
          byteSize: 0,
          sha256: null,
          executable: false,
          contentType: "application/octet-stream",
          deletedAt: null,
          updatedAt,
        });
      if (op.action === "delete")
        state.files.forEach((f) => {
          if (f.path === op.path || f.path.startsWith(`${op.path}/`))
            f.deletedAt = updatedAt;
        });
      const selected = state.files.find((f) => f.id === op.fileId);
      const inDeletedTree = (f: WorkFile) =>
        Boolean(
          selected &&
            f.deletedAt &&
            (f.id === selected.id || f.path.startsWith(`${selected.path}/`)),
        );
      if (op.action === "restore")
        state.files.forEach((f) => {
          if (inDeletedTree(f)) f.deletedAt = null;
        });
      if (op.action === "purge") {
        for (const file of state.files.filter(inDeletedTree)) {
          state.contents.delete(file.path);
        }
        state.files = state.files.filter((f) => !inDeletedTree(f));
      }
    } else return fail("Unsupported fixture operation", 405);
    state.changed = true;
    return Response.json({ ok: true });
  }
  return { handle };
}
