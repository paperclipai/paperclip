/**
 * Workspace landing page — the center stage when a workspace is selected.
 *
 * Shows the Paperclip logo and action shortcuts (Terminal, Chat, Search, etc.)
 * matching Superset's workspace-first UX. If no workspace is selected,
 * prompts the user to pick one.
 */

import { useNavigate } from "@/lib/router";
import {
  TerminalSquare,
  MessageSquare,
  Search,
  LayoutDashboard,
  FolderOpen,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "../context/WorkspaceContext";

export function WorkspaceLandingPage() {
  const { selected, cwd, clearWorkspace } = useWorkspace();
  const navigate = useNavigate();

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  if (!cwd) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted">
          <FolderOpen className="h-8 w-8 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">No workspace selected</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Select a workspace from the sidebar or add a new repository to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-6">
      {/* Paperclip logo / workspace identity */}
      <div className="flex flex-col items-center gap-3">
        <div className="text-4xl font-bold tracking-tight text-foreground/20 font-mono select-none">
          {"{{ PAPERCLIP }}"}
        </div>
      </div>

      {/* Action shortcuts */}
      <div className="flex flex-col gap-2 w-full max-w-md">
        <WorkspaceAction
          icon={TerminalSquare}
          label="Open Terminal"
          shortcut="⌘ T"
          onClick={() => navigate("/terminal")}
        />
        <WorkspaceAction
          icon={MessageSquare}
          label="Open Chat"
          shortcut="⌘ ⇧ T"
          onClick={() => navigate("/plugins/paperclip-chat")}
        />
        <WorkspaceAction
          icon={Search}
          label="Search Files"
          shortcut="⌘ P"
          onClick={openSearch}
        />
        <WorkspaceAction
          icon={LayoutDashboard}
          label="Open Dashboard"
          shortcut="⌘ D"
          onClick={() => navigate("/dashboard")}
        />
      </div>

      {/* Workspace info + delete */}
      <div className="flex flex-col items-center gap-2 mt-4">
        {selected && (
          <div className="text-xs text-muted-foreground text-center">
            <span className="font-medium text-foreground">{selected.workspace.name}</span>
            {" · "}
            <span className="font-mono">{selected.cwd}</span>
            {selected.workspace.repoRef && (
              <>
                {" · "}
                <span className="font-mono">{selected.workspace.repoRef}</span>
              </>
            )}
          </div>
        )}
        {!selected && cwd && (
          <div className="text-xs text-muted-foreground font-mono">{cwd}</div>
        )}

        <button
          onClick={() => {
            clearWorkspace();
            navigate("/dashboard");
          }}
          className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-destructive transition-colors mt-2"
        >
          <Trash2 className="h-3 w-3" />
          Close workspace
        </button>
      </div>
    </div>
  );
}

function WorkspaceAction({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full px-4 py-3 rounded-lg hover:bg-accent/50 transition-colors group"
    >
      <Icon className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors" />
      <span className="flex-1 text-sm font-medium text-foreground text-left">{label}</span>
      <div className="flex items-center gap-1">
        {shortcut.split(" ").map((key, i) => (
          <kbd
            key={i}
            className="px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground bg-muted rounded border border-border/50"
          >
            {key}
          </kbd>
        ))}
      </div>
    </button>
  );
}
