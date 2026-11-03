import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { accessApi } from "../../api/access";
import { queryKeys } from "../../lib/queryKeys";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { PropertyRow } from "./primitives";

export function ResponsibleOwnerRow({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const accessKey = ["issues", issue.id, "responsible-owner"];
  const access = useQuery({ queryKey: accessKey, queryFn: () => issuesApi.responsibleOwnerAccess(issue.id) });
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(issue.companyId),
    queryFn: () => accessApi.listUserDirectory(issue.companyId),
  });
  const transfer = useMutation({
    mutationFn: (userId: string) => issuesApi.transferResponsibleOwner(issue.id, userId, issue.responsibleUserId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
  });
  const ownerId = issue.responsibleUserId ?? issue.createdByUserId;
  const users = directory.data?.users ?? [];
  const owner = users.find((user) => user.principalId === ownerId);
  const label = owner?.user?.name ?? owner?.user?.email ?? (ownerId ? "User" : "Unassigned");
  const activeRun = Boolean(issue.executionRunId || issue.checkoutRunId);
  return (
    <PropertyRow label="Responsible owner">
      <div className="min-w-0 flex-1">
        {access.data?.canTransfer ? (
          <Select value={ownerId ?? ""} onValueChange={(id) => transfer.mutate(id)} disabled={transfer.isPending || activeRun || directory.isPending}>
            <SelectTrigger aria-label="Responsible owner"><SelectValue placeholder={label} /></SelectTrigger>
            <SelectContent>
              {users.map((user) => (
                <SelectItem key={user.principalId} value={user.principalId}>
                  {user.user?.name ?? user.user?.email ?? "User"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : <span className="text-sm">{label}</span>}
        {access.data?.canTransfer && activeRun ? <p className="text-xs text-muted-foreground">Stop the active run to transfer ownership.</p> : null}
        {transfer.error ? <p role="alert" className="text-xs text-destructive">{transfer.error.message}</p> : null}
        {access.error ? <p role="alert" className="text-xs text-destructive">Could not load ownership permissions.</p> : null}
        {directory.error ? <p role="alert" className="text-xs text-destructive">Could not load company users.</p> : null}
      </div>
    </PropertyRow>
  );
}
