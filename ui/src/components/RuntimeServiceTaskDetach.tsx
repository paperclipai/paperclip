import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { DetachRuntimeServiceTask, RuntimeService } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { runtimeServicesApi } from "../api/runtime-services";
import { publishRuntimeService, serviceKeys } from "../hooks/useRuntimeServices";
import { Button } from "./ui/button";

export function RuntimeServiceTaskDetach({ service, disabled }: { service: RuntimeService; disabled: boolean }) {
  const client = useQueryClient();
  const request = useRef<DetachRuntimeServiceTask | null>(null);
  const submitting = useRef(false);
  const mutation = useMutation({ mutationKey: serviceKeys.mutation(service.companyId, service.id),
    mutationFn: (input: DetachRuntimeServiceTask) => runtimeServicesApi.detachTask(service.companyId, service.id, input),
    onSuccess: (result) => {
      request.current = null;
      publishRuntimeService(client, result);
      void client.invalidateQueries({ queryKey: serviceKeys.company(service.companyId) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        request.current = null;
        void client.invalidateQueries({ queryKey: serviceKeys.detail(service.companyId, service.id) });
      }
    },
    onSettled: () => { submitting.current = false; },
  });
  return <div className="flex flex-col gap-2">
    <Button className="self-start" variant="outline" size="sm" disabled={disabled || mutation.isPending || !service.taskWorkspace} onClick={() => {
      if (submitting.current || !service.taskWorkspace) return;
      submitting.current = true;
      request.current ??= { issueId: service.taskWorkspace.issueId, requestId: crypto.randomUUID(), expectedRevision: service.revision };
      mutation.mutate(request.current);
    }}>{mutation.isPending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}{mutation.isPending ? "Detaching…" : request.current ? "Retry detachment" : "Detach task workspace"}</Button>
    <p className="text-xs text-muted-foreground">Detaching restores the earlier workspace unless a newer one has been selected. Service files stay available.</p>
    {mutation.isError && <p className="text-sm text-destructive" role="alert">{request.current ? "Detachment could not be confirmed. Retry the same request to check its result." : mutation.error.message}</p>}
    <span className="sr-only" role="status" aria-live="polite">{mutation.isPending ? "Detaching task workspace" : ""}</span>
  </div>;
}
