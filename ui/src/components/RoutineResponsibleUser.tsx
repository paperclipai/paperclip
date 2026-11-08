import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoutineDetail } from "@paperclipai/shared";
import { Check, ChevronDown, UserRound } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { describeError } from "@/api/errors";
import { routinesApi } from "@/api/routines";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { QueryErrorState, useQueryView } from "./QueryView";

export function RoutineResponsibleUser({ routine }: { routine: RoutineDetail }) {
  const { t } = useTranslation("task-components");
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(routine.companyId),
    queryFn: () => accessApi.listUserDirectory(routine.companyId),
  });
  const directoryView = useQueryView(directory);
  const profiles = buildCompanyUserProfileMap(directory.data?.users);
  const label = routine.responsibleUserId
    ? profiles.get(routine.responsibleUserId)?.label
      ?? (directory.isPending ? t("task-components:loading_ba3bbbe1") : t("task-components:routineUnavailableUser"))
    : t("task-components:routineNoResponsibleUser");
  const change = useMutation({
    mutationFn: (responsibleUserId: string) => routinesApi.update(routine.id, {
      responsibleUserId,
      baseRevisionId: routine.latestRevisionId,
    }),
    onSuccess: async (saved) => {
      queryClient.setQueryData<RoutineDetail>(queryKeys.routines.detail(routine.id), (current) => (
        current ? { ...current, ...saved } : current
      ));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routine.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(routine.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.revisions(routine.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(routine.companyId, routine.id) }),
      ]);
    },
  });

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="routine-responsible-heading">
      <h2 id="routine-responsible-heading" className="text-sm font-semibold">{t("task-components:routineResponsibleUser")}</h2>
      {routine.canChangeResponsibleUser ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("task-components:routineChangeResponsibleUserLabel", { label })}
              disabled={change.isPending || !directory.data}
              className="group flex w-fit max-w-full items-center gap-2 rounded-md text-left text-sm font-medium hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{change.isPending ? t("task-components:saving_23e39291") : label}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              <CommandInput placeholder={t("task-components:routineFindPerson")} aria-label={t("task-components:routineFindResponsibleUser")} />
              <CommandList aria-label={t("task-components:routineResponsibleUser")}>
                <CommandEmpty>{t("task-components:routineNoPeopleFound")}</CommandEmpty>
                {(directory.data?.users ?? []).map((member) => (
                  <CommandItem
                    key={member.principalId}
                    value={`${member.principalId} ${profiles.get(member.principalId)?.label} ${member.user?.email ?? ""}`}
                    onSelect={() => {
                      setOpen(false);
                      if (member.principalId !== routine.responsibleUserId) change.mutate(member.principalId);
                    }}
                  >
                    <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{profiles.get(member.principalId)?.label}</span>
                    {member.principalId === routine.responsibleUserId ? <Check className="h-4 w-4" aria-label={t("task-components:routineCurrentResponsibleUser")} /> : null}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : (
        <p className="flex items-center gap-2 text-sm font-medium">
          <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("task-components:routineResponsibleUserHelp")}</p>
      {directoryView.kind === "error" ? (
        <QueryErrorState error={directoryView.error} size="inline" action={t("task-components:routineLoadPeople")} onRetry={directoryView.retry} retrying={directoryView.isFetching} />
      ) : null}
      {change.error ? (
        <p role="alert" className="text-xs text-destructive">
          {change.error instanceof ApiError && change.error.status === 409
            ? t("task-components:routineResponsibilityStale")
            : describeError(change.error, { action: t("task-components:routineChangeResponsibility") }).body}
        </p>
      ) : null}
    </section>
  );
}
