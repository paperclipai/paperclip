/**
 * Terminal page — opens a shell in the globally selected workspace.
 *
 * If no workspace is selected, shows a prompt to pick one from the sidebar.
 * The workspace selector in the sidebar controls which cwd the terminal uses.
 */

import { TerminalSquare, FolderOpen } from "lucide-react";
import { TerminalPanel } from "../components/Terminal";
import { useWorkspace } from "../context/WorkspaceContext";

export function TerminalPage() {
  const { cwd, selected, branch } = useWorkspace();

  if (!cwd) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-muted">
          <TerminalSquare className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">No workspace selected</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Pick a workspace from the selector in the sidebar to open a terminal session.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FolderOpen className="h-3.5 w-3.5" />
          <span>Click the workspace selector below the company name</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-border">
        <div className="flex items-center gap-2 text-sm">
          <TerminalSquare className="h-4 w-4 text-muted-foreground" />
          {selected && (
            <span className="font-medium text-foreground">{selected.workspace.name}</span>
          )}
          {branch && (
            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-accent text-muted-foreground">{branch}</span>
          )}
          <span className="font-mono text-muted-foreground text-xs">{cwd}</span>
        </div>
      </div>
      <TerminalPanel cwd={cwd} className="flex-1 min-h-0" />
    </div>
  );
}
