import { parseCodexTurnDiff, type ParsedCodexTurnDiffFile } from "./codex-turn-diff.js";
import { boundedCodexWorkspaceStat as boundedWorkspaceStat, codexWorkspaceRelativePath as workspaceRelativePath } from "./codex-thread-normalization.js";
import type { CodexSessionState } from "./codex-session-state.js";
import { record, text } from "./codex-driver-values.js";

export function recordWorkspaceChanges(
  state: CodexSessionState,
    turnId: string,
    value: unknown,
    complete: boolean,
  ): void {
    const changes = Array.isArray(value) ? value : [];
    const files = changes
      .slice(0, 2_000)
      .flatMap((candidate): Record<string, unknown>[] => {
        const change = record(candidate);
        const path = text(change.path).replaceAll("\\", "/");
        if (!path || path.startsWith("/") || path.split("/").includes(".."))
          return [];
        const kind = change.kind;
        const kindRecord = record(kind);
        const kindText = text(
          kind,
          text(kindRecord.type, Object.keys(kindRecord)[0] ?? "update"),
        );
        const update = record(kindRecord.update ?? change.update);
        const previousPath =
          text(update.move_path, text(update.movePath)) || null;
        const operation = previousPath
          ? "rename"
          : kindText.toLowerCase().includes("add")
            ? "create"
            : kindText.toLowerCase().includes("delete")
              ? "delete"
              : "modify";
        const diff = text(change.diff).slice(0, 262_144) || null;
        const diffLines = diff?.split("\n") ?? [];
        return [
          {
            path,
            operation,
            previousPath,
            additions:
              diff === null
                ? null
                : diffLines.filter(
                    (line) => line.startsWith("+") && !line.startsWith("+++"),
                  ).length,
            deletions:
              diff === null
                ? null
                : diffLines.filter(
                    (line) => line.startsWith("-") && !line.startsWith("---"),
                  ).length,
            binary: diff === null,
            diff,
          },
        ];
      });
    if (files.length === 0) return;
    const unknown = files.some(
      (file) => file.additions === null || file.deletions === null,
    );
    const payload = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turnId}:workspace`,
      revision:
        Number(record(state.workspaceChangesByTurn.get(turnId)).revision ?? 0) +
        1,
      source: "harness_reported",
      complete,
      files,
      totals: {
        files: files.length,
        additions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.additions), 0),
        deletions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.deletions), 0),
      },
      patchArtifactRef: null,
    };
    state.workspaceChangesByTurn.set(turnId, payload);
    state.emit("workspace.change.updated", payload, {
      turnId,
      itemId: `${turnId}:workspace`,
    });
  }

export function recordTurnDiff(
  state: CodexSessionState,turnId: string, value: unknown): void {
    const diff = text(value);
    const files = parseCodexTurnDiff(diff);
    // An empty string is an authoritative empty aggregate snapshot. A
    // non-empty value that cannot be parsed is left on the bounded diagnostic
    // item.delta path instead of erasing the last valid workspace snapshot.
    if (files.length === 0 && diff.trim()) return;
    recordWorkspaceSnapshot(state, turnId, files);
  }

export function recordCanonicalWorkspaceChange(
  state: CodexSessionState,turnId: string, value: unknown): void {
    const candidate = record(value);
    if (candidate.schema !== "paperclip.workspace.diff.v1") return;
    if (!Array.isArray(candidate.files)) return;
    const files = candidate.files.slice(0, 2_000).flatMap((value) => {
      const file = record(value);
      const path = workspaceRelativePath(file.path);
      if (path === null) return [];
      const operation = text(file.operation);
      if (
        operation !== "create" &&
        operation !== "modify" &&
        operation !== "delete" &&
        operation !== "rename" &&
        operation !== "mode_change"
      ) return [];
      const previousPath =
        file.previousPath === null || file.previousPath === undefined
          ? null
          : workspaceRelativePath(file.previousPath);
      if (operation === "rename" && previousPath === null) return [];
      const binary = file.binary === true;
      const diff =
        binary || file.diff === null || file.diff === undefined
          ? null
          : typeof file.diff === "string"
            ? file.diff.slice(0, 262_144)
            : null;
      const additions = boundedWorkspaceStat(file.additions);
      const deletions = boundedWorkspaceStat(file.deletions);
      return [{
        path,
        operation: operation as ParsedCodexTurnDiffFile["operation"],
        previousPath,
        additions: binary ? null : additions,
        deletions: binary ? null : deletions,
        binary,
        diff,
      }];
    });
    // Empty is an authoritative snapshot. If the provider supplied entries
    // but every one failed validation, retain the previous valid revision.
    if (candidate.files.length > 0 && files.length === 0) return;
    recordWorkspaceSnapshot(state,
      turnId,
      files,
      candidate.revision,
      typeof candidate.patchArtifactRef === "string"
        ? candidate.patchArtifactRef.slice(0, 2_048)
        : null,
    );
  }

function recordWorkspaceSnapshot(
  state: CodexSessionState,
    turnId: string,
    files: ReturnType<typeof parseCodexTurnDiff>,
    requestedRevision?: unknown,
    patchArtifactRef: string | null = null,
  ): void {
    const previous = state.workspaceChangesByTurn.get(turnId);
    if (
      previous !== undefined &&
      JSON.stringify(record(previous).files) === JSON.stringify(files) &&
      record(previous).patchArtifactRef === patchArtifactRef
    ) return;
    const unknown = files.some(
      (file) => file.additions === null || file.deletions === null,
    );
    const priorRevision = Number(record(previous).revision ?? 0);
    const incomingRevision =
      typeof requestedRevision === "number" &&
      Number.isSafeInteger(requestedRevision) &&
      requestedRevision > 0
        ? requestedRevision
        : 1;
    const payload = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turnId}:workspace`,
      revision: Math.max(priorRevision + 1, incomingRevision),
      source: "harness_reported",
      complete: false,
      files,
      totals: {
        files: files.length,
        additions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.additions), 0),
        deletions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.deletions), 0),
      },
      patchArtifactRef,
    };
    state.workspaceChangesByTurn.set(turnId, payload);
    state.emit("workspace.change.updated", payload, {
      turnId,
      itemId: `${turnId}:workspace`,
    });
  }
