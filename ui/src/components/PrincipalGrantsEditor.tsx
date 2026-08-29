import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { PERMISSION_KEYS, type PermissionKey } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";

const GRANT_LABELS: Partial<Record<PermissionKey, string>> = {
  "agents:configure": "Configure peer agents",
  "agents:create": "Create or hire agents",
  "agents:suggest-changes": "Suggest agent changes",
  "skills:create": "Create or import skills",
  "skills:suggest-changes": "Suggest skill changes",
  "environments:manage": "Manage environments",
  "tools:admin": "Administer tools",
  "tools:manage_connections": "Manage tool connections",
  "tools:manage_profiles": "Manage tool profiles",
  "tools:manage_runtime": "Manage tool runtime",
  "tools:view_audit": "View tool audit",
  "tools:use": "Use tools",
  "audit:view_agent_actions": "View agent action audit",
  "inbox:manage": "Manage inbox",
  "users:invite": "Invite users",
  "users:manage_permissions": "Manage member permissions",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Assign tasks within scope",
  "tasks:manage_active_checkouts": "Manage active checkouts",
  "pipelines:write": "Write pipelines",
  "joins:approve": "Approve join requests",
};

const DANGEROUS_KEYS: PermissionKey[] = ["users:manage_permissions"];

export interface PrincipalGrantDraft {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
}

export function PrincipalGrantsEditor({
  companyId,
  agentId,
  currentGrants,
  disabled = false,
}: {
  companyId: string;
  agentId: string;
  currentGrants: PrincipalGrantDraft[];
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(currentGrants.map((grant) => grant.permissionKey)),
  );

  useEffect(() => {
    setSelectedKeys(new Set(currentGrants.map((grant) => grant.permissionKey)));
  }, [agentId, currentGrants]);

  const accessQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    staleTime: 30_000,
    retry: false,
  });

  const canManageAgentGrants = accessQuery.data?.access.canManageAgentGrants === true;

  const scopeByKey = useMemo(() => {
    const map = new Map<string, Record<string, unknown> | null>();
    for (const grant of currentGrants) {
      map.set(grant.permissionKey, grant.scope ?? null);
    }
    return map;
  }, [currentGrants]);

  const saveGrants = useMutation({
    mutationFn: () =>
      agentsApi.updateGrants(
        agentId,
        {
          grants: PERMISSION_KEYS.filter((key) => selectedKeys.has(key)).map((key) => ({
            permissionKey: key,
            scope: scopeByKey.get(key) ?? null,
          })),
        },
        companyId,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      pushToast({ title: "Grants saved", tone: "success" });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not save grants";
      pushToast({ title: "Save failed", body: message, tone: "error" });
    },
  });

  if (accessQuery.isLoading) return null;
  if (!canManageAgentGrants) return null;

  const grantsDirty =
    PERMISSION_KEYS.filter((key) => selectedKeys.has(key)).join(",") !==
    currentGrants.map((grant) => grant.permissionKey).join(",");
  const showEscalationWarning = DANGEROUS_KEYS.some((key) => selectedKeys.has(key));

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Permission grants</h3>
        <p className="text-xs text-muted-foreground">
          Saving replaces all grants for this agent with the checked set below. Unchecking a key
          revokes it on save.
        </p>
      </div>
      {showEscalationWarning ? (
        <div className="flex items-start gap-3 border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Granting <span className="font-medium">users:manage_permissions</span> lets this agent
            rewrite permission grants for human company members.
          </p>
        </div>
      ) : null}
      <div className="rounded-lg border border-border">
        {PERMISSION_KEYS.map((key) => {
          const scope = scopeByKey.get(key) ?? null;
          const checked = selectedKeys.has(key);
          return (
            <label
              key={key}
              className="flex items-start justify-between gap-4 border-b border-border p-3 text-sm last:border-b-0"
            >
              <span className="space-y-0.5">
                <span className="block font-mono text-xs">{key}</span>
                {GRANT_LABELS[key] ? (
                  <span className="block text-xs text-muted-foreground">{GRANT_LABELS[key]}</span>
                ) : null}
                {scope ? (
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    scope: {JSON.stringify(scope)}
                  </span>
                ) : null}
              </span>
              <Checkbox
                checked={checked}
                disabled={disabled || saveGrants.isPending}
                onCheckedChange={(next) => {
                  setSelectedKeys((prev) => {
                    const nextSet = new Set(prev);
                    if (next === true) nextSet.add(key);
                    else nextSet.delete(key);
                    return nextSet;
                  });
                }}
              />
            </label>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={disabled || saveGrants.isPending || !grantsDirty}
          onClick={() => saveGrants.mutate()}
        >
          {saveGrants.isPending ? "Saving…" : "Save grants"}
        </Button>
      </div>
    </div>
  );
}
