import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import {
  agentPermissionsApi,
  type AgentAclPermission,
} from "../api/agentPermissions";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "../lib/utils";

function grantKey(agentId: string, permission: AgentAclPermission) {
  return `${agentId}:${permission}`;
}

export function AgentAclMatrix({
  companyId,
  granteeAgent,
  /** When false, only the comment matrix is shown (e.g. agent cannot assign tasks). */
  showAssignMatrix = true,
}: {
  companyId: string;
  granteeAgent: Agent;
  showAssignMatrix?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const targets = useMemo(() => {
    if (!agents) return [];
    return agents
      .filter((a) => a.id !== granteeAgent.id && a.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, granteeAgent.id]);

  const {
    data: grants = [],
    isLoading: grantsLoading,
    error: grantsError,
  } = useQuery({
    queryKey: queryKeys.agentAcl.grantsByGrantee(companyId, granteeAgent.id),
    queryFn: () => agentPermissionsApi.listByGrantee(companyId, granteeAgent.id),
    enabled: Boolean(companyId && granteeAgent.id),
  });

  const grantIdByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of grants) {
      if (g.granteeId === granteeAgent.id) {
        m.set(grantKey(g.agentId, g.permission), g.id);
      }
    }
    return m;
  }, [grants, granteeAgent.id]);

  const mutation = useMutation({
    mutationFn: async ({
      targetAgentId,
      permission,
      nextChecked,
    }: {
      targetAgentId: string;
      permission: AgentAclPermission;
      nextChecked: boolean;
    }) => {
      if (nextChecked) {
        await agentPermissionsApi.create(companyId, {
          granteeId: granteeAgent.id,
          agentId: targetAgentId,
          permission,
        });
      } else {
        const gid = grantIdByKey.get(grantKey(targetAgentId, permission));
        if (gid) {
          await agentPermissionsApi.remove(companyId, gid);
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentAcl.grantsByGrantee(companyId, granteeAgent.id),
      });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not update permission";
      pushToast({ title: "Permission update failed", body: message, tone: "error" });
    },
  });

  const selectAllMutation = useMutation({
    mutationFn: async ({ permission }: { permission: AgentAclPermission }) => {
      const unchecked = targets.filter((t) => !grantIdByKey.has(grantKey(t.id, permission)));
      await Promise.all(
        unchecked.map((t) =>
          agentPermissionsApi.create(companyId, {
            granteeId: granteeAgent.id,
            agentId: t.id,
            permission,
          }),
        ),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentAcl.grantsByGrantee(companyId, granteeAgent.id),
      });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not update permissions";
      pushToast({ title: "Select all failed", body: message, tone: "error" });
    },
  });

  const apiMissing =
    grantsError instanceof ApiError && (grantsError.status === 404 || grantsError.status === 501);

  const busy = agentsLoading || grantsLoading || mutation.isPending || selectAllMutation.isPending;

  if (agentsLoading || grantsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (apiMissing) {
    return (
      <p className="text-sm text-muted-foreground">
        Agent-to-agent permission APIs are not available on this Paperclip instance yet. Update the
        server to enable this matrix.
      </p>
    );
  }

  if (grantsError) {
    return (
      <p className="text-sm text-destructive">
        {grantsError instanceof Error ? grantsError.message : "Failed to load agent permissions."}
      </p>
    );
  }

  if (targets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add more agents to configure assignment and comment permissions between agents.
      </p>
    );
  }

  const renderMatrix = (permission: AgentAclPermission, title: string, description: string) => {
    const allChecked = targets.every((t) => grantIdByKey.has(grantKey(t.id, permission)));
    const someChecked = targets.some((t) => grantIdByKey.has(grantKey(t.id, permission)));
    return (
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div>
          <div className="text-sm font-medium">{title}</div>
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        </div>
        <div className="flex items-center gap-2 pb-2 border-b border-border">
          <Checkbox
            id={`acl-${granteeAgent.id}-${permission}-select-all`}
            checked={allChecked ? true : someChecked ? "indeterminate" : false}
            disabled={busy || allChecked}
            onCheckedChange={(v) => {
              if (v === true) {
                selectAllMutation.mutate({ permission });
              }
            }}
          />
          <Label
            htmlFor={`acl-${granteeAgent.id}-${permission}-select-all`}
            className={cn("text-sm font-medium cursor-pointer", busy && "opacity-70")}
          >
            Select all
          </Label>
        </div>
        <ul className="space-y-2">
          {targets.map((a) => {
            const checked = Boolean(grantIdByKey.get(grantKey(a.id, permission)));
            const id = `acl-${granteeAgent.id}-${permission}-${a.id}`;
            return (
              <li key={a.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={busy}
                  onCheckedChange={(v) => {
                    const next = v === true;
                    if (next === checked) return;
                    mutation.mutate({ targetAgentId: a.id, permission, nextChecked: next });
                  }}
                />
                <Label htmlFor={id} className={cn("text-sm font-normal cursor-pointer", busy && "opacity-70")}>
                  {a.name}
                </Label>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {showAssignMatrix
        ? renderMatrix(
            "assign",
            "Assignment permissions",
            `Grant ${granteeAgent.name} permission to assign tasks to each agent below.`,
          )
        : null}
      {renderMatrix(
        "comment",
        "Comment permissions",
        `Grant ${granteeAgent.name} permission to comment on issues assigned to each agent below.`,
      )}
    </div>
  );
}
