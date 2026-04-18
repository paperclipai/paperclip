import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { departmentsApi, teamsApi, type DepartmentTreeNode, type Team } from "../api/departments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, ChevronRight, ChevronDown, Plus, Users, FolderTree } from "lucide-react";
import { useEffect } from "react";

function DepartmentTreeItem({
  node,
  depth = 0,
}: {
  node: DepartmentTreeNode;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <Link
        to={`/departments/${node.id}`}
        className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/50 transition-colors group"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="p-0.5 rounded hover:bg-accent"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate">{node.name}</span>
        {node.memberCount > 0 && (
          <Badge variant="secondary" className="ml-auto text-xs">
            <Users className="h-3 w-3 mr-1" />
            {node.memberCount}
          </Badge>
        )}
        {hasChildren && (
          <Badge variant="outline" className="text-xs">
            {node.children.length} sub
          </Badge>
        )}
      </Link>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <DepartmentTreeItem key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Departments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [showNewTeamDialog, setShowNewTeamDialog] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamDescription, setNewTeamDescription] = useState("");
  const [newTeamDepartmentId, setNewTeamDepartmentId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Departments" }]);
  }, [setBreadcrumbs]);

  const { data: tree, isLoading } = useQuery({
    queryKey: queryKeys.departments.tree(selectedCompanyId!),
    queryFn: () => departmentsApi.tree(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: teams } = useQuery({
    queryKey: queryKeys.teams.list(selectedCompanyId!),
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: flatDepartments } = useQuery({
    queryKey: queryKeys.departments.list(selectedCompanyId!),
    queryFn: () => departmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; parentId?: string | null }) =>
      departmentsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.tree(selectedCompanyId!) });
      setShowNewDialog(false);
      setNewName("");
      setNewDescription("");
      setNewParentId(null);
      pushToast({ title: "Department created", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to create department", body: err.message, tone: "error" });
    },
  });

  const createTeamMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; departmentId?: string | null }) =>
      teamsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.teams.list(selectedCompanyId!) });
      setShowNewTeamDialog(false);
      setNewTeamName("");
      setNewTeamDescription("");
      setNewTeamDepartmentId(null);
      pushToast({ title: "Team created", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to create team", body: err.message, tone: "error" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  const hasDepartments = tree && tree.length > 0;
  const hasTeams = teams && teams.length > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderTree className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Departments</h1>
          {hasDepartments && (
            <Badge variant="secondary" className="text-xs">
              {tree.reduce(function countAll(acc: number, n: DepartmentTreeNode): number {
                return n.children.reduce(countAll, acc + 1);
              }, 0)}
            </Badge>
          )}
        </div>
        <Button size="sm" onClick={() => setShowNewDialog(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Department
        </Button>
      </div>

      {!hasDepartments ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Building2 className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h2 className="text-base font-medium">No departments yet</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Create departments to organize your agents, projects, and issues by team or function.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setShowNewDialog(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Create first department
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          {tree.map((node) => (
            <DepartmentTreeItem key={node.id} node={node} />
          ))}
        </div>
      )}

      <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-base font-semibold">Teams</h2>
              {hasTeams && <Badge variant="secondary" className="text-xs">{teams!.length}</Badge>}
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowNewTeamDialog(true)}>
              <Plus className="h-4 w-4 mr-1" />
              New Team
            </Button>
          </div>
      {hasTeams ? (
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {teams!.map((team: Team) => (
              <Link
                key={team.id}
                to={`/teams/${team.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors"
              >
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{team.name}</span>
                {team.description && (
                  <span className="text-xs text-muted-foreground truncate">{team.description}</span>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No teams yet. Create a team to group members across departments.
          </div>
        )}
      </div>

      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Department</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate({
                name: newName,
                description: newDescription || undefined,
                parentId: newParentId || undefined,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Engineering"
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional description"
                rows={2}
              />
            </div>
            {flatDepartments && flatDepartments.length > 0 && (
              <div>
                <label className="text-sm font-medium">Parent Department</label>
                <Select
                  value={newParentId ?? "__none__"}
                  onValueChange={(v) => setNewParentId(v === "__none__" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None (root level)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None (root level)</SelectItem>
                    {flatDepartments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewTeamDialog} onOpenChange={setShowNewTeamDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Team</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createTeamMutation.mutate({
                name: newTeamName,
                description: newTeamDescription || undefined,
                departmentId: newTeamDepartmentId || undefined,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="e.g. Platform Squad"
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={newTeamDescription}
                onChange={(e) => setNewTeamDescription(e.target.value)}
                placeholder="Optional description"
                rows={2}
              />
            </div>
            {flatDepartments && flatDepartments.length > 0 && (
              <div>
                <label className="text-sm font-medium">Department</label>
                <Select
                  value={newTeamDepartmentId ?? "__none__"}
                  onValueChange={(v) => setNewTeamDepartmentId(v === "__none__" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {flatDepartments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewTeamDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newTeamName.trim() || createTeamMutation.isPending}>
                {createTeamMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
