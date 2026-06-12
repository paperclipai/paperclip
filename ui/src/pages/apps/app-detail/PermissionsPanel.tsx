import { useEffect, useState } from "react";
import type { Agent, ToolCatalogEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { AccessDraft, AppDetailSectionProps } from "./types";

export function PermissionsPanel({
  access,
  agents,
  canChange,
  enabledIds,
  askFirstIds,
  pending,
  onSaveAccess,
  onToggleAskFirst,
}: Pick<
  AppDetailSectionProps,
  "access" | "agents" | "canChange" | "enabledIds" | "askFirstIds" | "pending"
> & {
  onSaveAccess: (next: AccessDraft) => void;
  onToggleAskFirst: (id: string, on: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      <AccessSection access={access} agents={agents} disabled={pending} onSave={onSaveAccess} />
      <AskFirstSection
        actions={canChange}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={pending}
        onToggleAskFirst={onToggleAskFirst}
      />
    </div>
  );
}

function AccessSection({
  access,
  agents,
  disabled,
  onSave,
}: {
  access: AccessDraft;
  agents: Agent[];
  disabled: boolean;
  onSave: (next: AccessDraft) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AccessDraft>(access);
  const liveAgents = agents.filter((a) => a.status !== "terminated");

  useEffect(() => {
    if (!editing) setDraft(access);
  }, [access, editing]);

  const summary =
    access.mode === "all"
      ? "Every agent can use it"
      : `${access.agentIds.size} ${access.agentIds.size === 1 ? "agent" : "agents"} can use it`;

  const canSave = draft.mode === "all" || draft.agentIds.size > 0;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">Who can use it</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>

      {editing && (
        <div className="space-y-3 border-t border-border px-5 py-4">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              className="mt-1"
              checked={draft.mode === "all"}
              onChange={() => setDraft({ mode: "all", agentIds: new Set() })}
            />
            <span>
              <span className="text-sm font-semibold text-foreground">All agents</span>
              <span className="block text-xs text-muted-foreground">Anyone you've added to Paperclip.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="radio"
              className="mt-1"
              checked={draft.mode === "specific"}
              onChange={() => setDraft({ mode: "specific", agentIds: new Set(draft.agentIds) })}
            />
            <span>
              <span className="text-sm font-semibold text-foreground">Only specific agents</span>
              <span className="block text-xs text-muted-foreground">Pick who can use it.</span>
            </span>
          </label>

          {draft.mode === "specific" && (
            <div className="rounded-lg border border-border">
              {liveAgents.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">No agents yet.</div>
              ) : (
                liveAgents.map((agent) => (
                  <label key={agent.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={draft.agentIds.has(agent.id)}
                      onChange={() => {
                        const next = new Set(draft.agentIds);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        setDraft({ mode: "specific", agentIds: next });
                      }}
                    />
                    <span className="text-sm font-medium text-foreground">{agent.name}</span>
                    {agent.title && <span className="truncate text-xs text-muted-foreground">- {agent.title}</span>}
                  </label>
                ))
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={disabled || !canSave}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={disabled}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function AskFirstSection({
  actions,
  enabledIds,
  askFirstIds,
  disabled,
  onToggleAskFirst,
}: {
  actions: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  onToggleAskFirst: (id: string, on: boolean) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-bold text-foreground">Needs your OK before running</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Pick which change-making actions should ask before they run.
        </p>
      </div>
      {actions.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">This app has no change-making actions.</p>
      ) : (
        <div className="divide-y divide-border">
          {actions.map((action) => {
            const enabled = enabledIds.has(action.id);
            const askFirst = askFirstIds.has(action.id);
            return (
              <div key={action.id} className="flex items-center gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{action.title ?? action.toolName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {enabled
                      ? askFirst
                        ? "Will ask before running."
                        : "Can run without asking."
                      : "Turn this action on in Setup first."}
                  </div>
                </div>
                <ToggleSwitch
                  checked={enabled && askFirst}
                  disabled={disabled || !enabled}
                  onCheckedChange={(next) => onToggleAskFirst(action.id, next)}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
