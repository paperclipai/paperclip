import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { History, Plus, Target, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { EntityRow } from "../EntityRow";
import { ActivityRow } from "../ActivityRow";
import { GoalTree } from "../GoalTree";
import { StatusBadge } from "../StatusBadge";
import { projectUrl } from "../../lib/utils";
import { AddCheckInForm, CheckInStatusBadge } from "./AddCheckInForm";
import type { GoalKeyResult } from "../../api/goalKeyResults";
import type { CreateCheckInPayload } from "../../api/goalCheckIns";
import type { Goal, Issue, Project, GoalCheckIn, Agent, ActivityEvent } from "@ironworksai/shared";

interface GoalTabsSectionProps {
  goal: Goal;
  goalId: string;
  goalIssues: Issue[];
  keyResults: GoalKeyResult[] | undefined;
  childGoals: Goal[];
  linkedProjects: Project[];
  checkIns: GoalCheckIn[] | undefined;
  goalActivity: ActivityEvent[];
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap: Map<string, string>;
  // Key result mutations
  showKrForm: boolean;
  setShowKrForm: (v: boolean) => void;
  krDescription: string;
  setKrDescription: (v: string) => void;
  krTarget: string;
  setKrTarget: (v: string) => void;
  krUnit: string;
  setKrUnit: (v: string) => void;
  editingKrId: string | null;
  setEditingKrId: (v: string | null) => void;
  editingKrValue: string;
  setEditingKrValue: (v: string) => void;
  isCreatingKr: boolean;
  onCreateKr: () => void;
  onUpdateKrValue: (krId: string, value: string) => void;
  onDeleteKr: (krId: string) => void;
  // Check-in
  isCreatingCheckIn: boolean;
  onCreateCheckIn: (data: CreateCheckInPayload) => void;
  // Dialogs
  onOpenNewIssue: (opts: { goalId: string }) => void;
  onOpenNewGoal: (opts: { parentId: string }) => void;
}

export function GoalTabsSection({
  goal,
  goalId,
  goalIssues,
  keyResults,
  childGoals,
  linkedProjects,
  checkIns,
  goalActivity,
  agentMap,
  entityNameMap,
  entityTitleMap,
  showKrForm,
  setShowKrForm,
  krDescription,
  setKrDescription,
  krTarget,
  setKrTarget,
  krUnit,
  setKrUnit,
  editingKrId,
  setEditingKrId,
  editingKrValue,
  setEditingKrValue,
  isCreatingKr,
  onCreateKr,
  onUpdateKrValue,
  onDeleteKr,
  isCreatingCheckIn,
  onCreateCheckIn,
  onOpenNewIssue,
  onOpenNewGoal,
}: GoalTabsSectionProps) {
  return (
    <Tabs defaultValue={goalIssues.length > 0 ? "issues" : "children"}>
      <TabsList>
        <TabsTrigger value="issues">
          Issues ({goalIssues.length})
        </TabsTrigger>
        <TabsTrigger value="key-results">
          Key Results ({(keyResults ?? []).length})
        </TabsTrigger>
        <TabsTrigger value="children">
          Sub-Goals ({childGoals.length})
        </TabsTrigger>
        <TabsTrigger value="projects">
          Projects ({linkedProjects.length})
        </TabsTrigger>
        <TabsTrigger value="check-ins">
          Check-ins ({(checkIns ?? []).length})
        </TabsTrigger>
        <TabsTrigger value="activity">
          Activity ({goalActivity.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="issues" className="mt-4 space-y-3">
        <div className="flex justify-end mb-2">
          <Button size="sm" variant="outline" onClick={() => onOpenNewIssue({ goalId })}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create Issue
          </Button>
        </div>
        {goalIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No missions linked to this goal yet.</p>
        ) : (
          <div className="border border-border rounded-lg divide-y divide-border">
            {goalIssues.map((issue: Issue) => (
              <EntityRow
                key={issue.id}
                title={issue.title}
                subtitle={issue.identifier ?? undefined}
                to={`/issues/${issue.identifier ?? issue.id}`}
                trailing={
                  <div className="flex items-center gap-2">
                    <StatusBadge status={issue.status} />
                  </div>
                }
              />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="key-results" className="mt-4 space-y-3">
        <div className="flex items-center justify-start">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowKrForm(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Key Result
          </Button>
        </div>

        {showKrForm && (
          <div className="border border-border rounded-lg p-3 space-y-2">
            <Input
              placeholder="Key result description..."
              value={krDescription}
              onChange={(e) => setKrDescription(e.target.value)}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Input
                placeholder="Target"
                type="number"
                inputMode="decimal"
                value={krTarget}
                onChange={(e) => setKrTarget(e.target.value)}
                className="w-24"
              />
              <Input
                placeholder="Unit"
                value={krUnit}
                onChange={(e) => setKrUnit(e.target.value)}
                className="w-20"
              />
              <Button
                size="sm"
                disabled={!krDescription.trim() || isCreatingKr}
                onClick={onCreateKr}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setShowKrForm(false); setKrDescription(""); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {(keyResults ?? []).length === 0 && !showKrForm ? (
          <p className="text-sm text-muted-foreground">No key results defined yet.</p>
        ) : (
          <div className="space-y-2">
            {(keyResults ?? []).map((kr: GoalKeyResult) => {
              const target = Number(kr.targetValue) || 100;
              const current = Number(kr.currentValue) || 0;
              const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

              return (
                <div key={kr.id} className="border border-border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Target className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{kr.description}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {editingKrId === kr.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            inputMode="decimal"
                            value={editingKrValue}
                            onChange={(e) => setEditingKrValue(e.target.value)}
                            className="w-20 h-7 text-xs"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                onUpdateKrValue(kr.id, editingKrValue);
                                setEditingKrId(null);
                              }
                              if (e.key === "Escape") setEditingKrId(null);
                            }}
                          />
                          <span className="text-xs text-muted-foreground">/ {kr.targetValue} {kr.unit}</span>
                        </div>
                      ) : (
                        <button
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => { setEditingKrId(kr.id); setEditingKrValue(kr.currentValue); }}
                        >
                          {current} / {kr.targetValue} {kr.unit} ({pct}%)
                        </button>
                      )}
                      <button
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => onDeleteKr(kr.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-300",
                        pct === 100 ? "bg-emerald-500" : pct > 50 ? "bg-blue-500" : "bg-amber-500",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </TabsContent>

      <TabsContent value="children" className="mt-4 space-y-3">
        <div className="flex items-center justify-start">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenNewGoal({ parentId: goalId })}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Sub Goal
          </Button>
        </div>
        {childGoals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sub-goals.</p>
        ) : (
          <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
        )}
      </TabsContent>

      <TabsContent value="projects" className="mt-4">
        {linkedProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked projects.</p>
        ) : (
          <div className="border border-border">
            {linkedProjects.map((project) => (
              <EntityRow
                key={project.id}
                title={project.name}
                subtitle={project.description ?? undefined}
                to={projectUrl(project)}
                trailing={<StatusBadge status={project.status} />}
              />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="check-ins" className="mt-4 space-y-4">
        <AddCheckInForm
          defaultConfidence={goal.confidence ?? 50}
          onSubmit={onCreateCheckIn}
          isPending={isCreatingCheckIn}
        />

        {(checkIns ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No check-ins yet.</p>
        ) : (
          <div className="space-y-3">
            {(checkIns ?? []).map((ci: GoalCheckIn) => (
              <div key={ci.id} className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    {new Date(ci.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <CheckInStatusBadge status={ci.status} />
                  {ci.confidence != null && (
                    <span className="text-[10px] text-muted-foreground">
                      Confidence: {ci.confidence}%
                    </span>
                  )}
                  {ci.authorAgentId && (
                    <span className="text-[10px] text-muted-foreground">
                      by {agentMap.get(ci.authorAgentId)?.name ?? "Agent"}
                    </span>
                  )}
                  {ci.authorUserId && (
                    <span className="text-[10px] text-muted-foreground">by User</span>
                  )}
                </div>
                {ci.note && <p className="text-sm">{ci.note}</p>}
                {ci.blockers && (
                  <div className="text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded px-2 py-1">
                    <span className="font-medium">Blockers:</span> {ci.blockers}
                  </div>
                )}
                {ci.nextSteps && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Next steps:</span> {ci.nextSteps}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="activity" className="mt-4">
        {goalActivity.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <History className="h-5 w-5" />
            <p className="text-sm">No activity yet for this goal or its linked missions.</p>
          </div>
        ) : (
          <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
            {goalActivity.map((event) => (
              <ActivityRow
                key={event.id}
                event={event}
                agentMap={agentMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
              />
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
