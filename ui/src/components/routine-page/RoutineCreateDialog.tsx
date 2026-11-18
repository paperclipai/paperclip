import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Routine } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { routinesApi } from "@/api/routines";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { EMPTY_ROUTINE_FORM_DRAFT, RoutineEditDialog, type RoutineFormDraft } from "./RoutineEditDialog";
import { routineFieldsPayload, syncRoutineResponsibility } from "./routine-form";
import { routinePath } from "./routine-routes";
import { useRoutineFormOptions } from "./useRoutineFormOptions";

/**
 * The routines list's "Create routine": the routine edit form in create mode.
 * A new routine is filed in `folderId` (the folder the list is showing) and
 * gets the default priority and delivery settings. Webhooks are added from the
 * routine page once it exists.
 */
export function RoutineCreateDialog({
  companyId,
  open,
  onOpenChange,
  folderId = null,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId?: string | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const options = useRoutineFormOptions(companyId, { active: open });
  const [error, setError] = useState<string | null>(null);
  const initial = useMemo<RoutineFormDraft>(() => ({ ...EMPTY_ROUTINE_FORM_DRAFT }), [open]);

  const create = useMutation({
    mutationFn: async (draft: RoutineFormDraft) => {
      const routine: Routine = await routinesApi.create(companyId, {
        ...routineFieldsPayload(draft),
        ...(folderId ? { folderId } : {}),
      });
      // Anything after this point is best effort: the routine exists, so report what is missing instead of failing.
      const missing: string[] = [];
      if (draft.responsibleUserId && draft.responsibleUserId !== routine.responsibleUserId) {
        await routinesApi.update(routine.id, { responsibleUserId: draft.responsibleUserId }).catch(() => missing.push("the responsible user"));
      }
      if (draft.schedule) {
        await routinesApi
          .createTrigger(routine.id, { kind: "schedule", cronExpression: draft.schedule.cronExpression, timezone: draft.schedule.timezone })
          .catch(() => missing.push("the schedule"));
      }
      if (options.responsibilitiesOn && draft.responsibilityId) {
        await syncRoutineResponsibility(routine.id, "", draft.responsibilityId).catch(() => missing.push("the responsibility"));
      }
      return { routine, missing };
    },
    onMutate: () => setError(null),
    onSuccess: async ({ routine, missing }) => {
      onOpenChange(false);
      pushToast(
        missing.length > 0
          ? { title: "Routine created", body: `Couldn’t save ${missing.join(" and ")}. Open Edit to try again.`, tone: "warn" }
          : { title: "Routine created", tone: "success" },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(companyId) });
      navigate(routinePath(routine.id));
    },
    onError: (cause) => setError(describeError(cause, { action: "create the routine" }).body),
  });

  return (
    <RoutineEditDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      mode="create"
      initial={initial}
      agents={options.agents}
      projects={options.projects}
      people={options.people}
      secrets={options.secrets}
      responsibilities={options.responsibilities}
      mentions={options.mentions}
      saving={create.isPending}
      error={error ?? (options.loadErrors.length > 0 ? "Some choices couldn’t be loaded. Close this and try again." : null)}
      onSave={(draft) => create.mutate(draft)}
      onCreateSecret={options.createSecret}
    />
  );
}
