import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeDepartmentName } from "@paperclipai/shared";
import { departmentsApi } from "@/api/departments";
import { useTx } from "@/i18n/tx";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Membership is saved here, not through the agent configuration form. A
// department list is not adapter config and must not take a configuration
// revision or block Save of the agent's name and title.
export function AgentDepartmentsField({ companyId, agentId }: { companyId: string; agentId: string }) {
  const tx = useTx();
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const departments = useQuery({
    queryKey: queryKeys.departments.list(companyId),
    queryFn: () => departmentsApi.list(companyId),
  });
  const rows = departments.data ?? [];
  const mine = rows.filter((department) => department.agentIds.includes(agentId));
  const invalidate = () => client.invalidateQueries({ queryKey: queryKeys.departments.list(companyId) });
  const replace = useMutation({
    mutationFn: (departmentIds: string[]) => departmentsApi.setForAgent(agentId, departmentIds),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (cause: Error) => setError(tx(cause.message || "Couldn’t save departments")),
  });
  const create = useMutation({
    mutationFn: (name: string) => departmentsApi.create(companyId, name),
    onSuccess: async (department) => {
      setDraft("");
      const ids = new Set(mine.map((row) => row.id));
      ids.add(department.id);
      await replace.mutateAsync([...ids]);
    },
    onError: (cause: Error) => setError(tx(cause.message || "Couldn’t add department")),
  });

  const add = () => {
    const name = normalizeDepartmentName(draft);
    if (!name) {
      setError(tx("Enter a department name of 1 to 80 characters"));
      return;
    }
    const existing = rows.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (mine.some((row) => row.id === existing.id)) {
        setDraft("");
        return;
      }
      setDraft("");
      replace.mutate([...mine.map((row) => row.id), existing.id]);
      return;
    }
    create.mutate(name);
  };

  const busy = replace.isPending || create.isPending;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{tx("Departments")}</div>
      <p className="text-xs text-muted-foreground">{tx("Optional. An agent can belong to several departments, or to none. This does not change who they report to.")}</p>
      <div className="flex flex-wrap gap-1.5">
        {mine.map((department) => (
          <button
            key={department.id}
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
            disabled={busy}
            aria-label={`${tx("Remove")} ${department.name}`}
            onClick={() => replace.mutate(mine.filter((row) => row.id !== department.id).map((row) => row.id))}
          >
            {department.name}
            <span aria-hidden>×</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          maxLength={80}
          placeholder="Add a department"
          aria-label="Add a department"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy || !draft.trim()} onClick={add}>+</Button>
      </div>
      {departments.isError && <p role="alert" className="text-xs text-destructive">{tx("Departments couldn’t be loaded.")}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
