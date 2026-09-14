import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, Play, RotateCcw, Square, Terminal } from "lucide-react";
import type { RuntimeService } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { formatDateTime } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import { runtimeServicesApi } from "../api/runtime-services";
import { serviceKeys, useRuntimeServiceOperation } from "../hooks/useRuntimeServices";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { StatusBadge } from "./StatusBadge";

export function servicePolicyLabel(service: RuntimeService): string {
  const policy = service.effectivePolicy ?? service.policy;
  const idle = policy.idleSeconds;
  return idle === null ? (policy.maxRunningSeconds === null ? "Runs until stopped" : "No idle sleep") : idle < 60 ? `Sleeps after ${idle} seconds idle` : `Sleeps after ${Math.round(idle / 60)} minutes idle`;
}

const stateLabels: Record<RuntimeService["state"], string> = {
  pending: "Start queued", starting: "Starting", ready: "Running", unhealthy: "Needs attention",
  sleeping: "Sleeping", stopping: "Stopping", stopped: "Stopped", failed: "Failed", deleted: "Removed",
};

export function RuntimeServiceControls({ service, canManage, stale = false, detail = false }: {
  service: RuntimeService; canManage: boolean; stale?: boolean; detail?: boolean;
}) {
  const policy = service.effectivePolicy ?? service.policy;
  const operation = useRuntimeServiceOperation(service);
  const [logsOpen, setLogsOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const logsId = useId();
  const logs = useQuery({
    queryKey: serviceKeys.logs(service.companyId, service.id),
    queryFn: ({ signal }) => runtimeServicesApi.logs(service.companyId, service.id, { signal }),
    enabled: logsOpen,
    refetchInterval: logsOpen ? 3_000 : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const pendingAction = operation.isPending && operation.variables && "action" in operation.variables ? operation.variables.action : null;
  const requested = pendingAction ? ({ start: "Requesting start…", stop: "Requesting stop…", restart: "Requesting restart…", sleep: "Requesting sleep…", delete: "Removing…" } as const)[pendingAction] : null;
  const transitioning = ["pending", "starting", "stopping"].includes(service.state);
  const disabled = !canManage || stale || operation.pending || operation.ambiguous || service.state === "deleted" || !!service.dataDeletion;
  const running = service.desiredState === "running";
  const tone = service.state === "ready" ? "running" : ["failed", "unhealthy"].includes(service.state) ? "failed" : transitioning ? "pending" : "idle";
  async function copy(name: string, url: string) {
    try { await copyTextToClipboard(url); setCopied(name); setCopyError(null); }
    catch { setCopyError("Could not copy the URL. Open the preview and copy its address."); }
  }
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={`${service.name} service`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {detail ? <h2 className="min-w-0 flex-1 break-words text-base font-medium">{service.name}</h2> : (
          <Link to={service.detailPath} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{service.name}</Link>
        )}
        <div className="flex items-center gap-1.5" role="status" aria-live="polite" aria-atomic="true">
          {(operation.pending || transitioning) && <Loader2 className="size-3.5 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" />}
          <StatusBadge status={service.dataDeletion?.state === "failed" ? "failed" : tone} label={service.dataDeletion ? ({ pending: "Deletion queued", deleting: "Deleting data", failed: "Deletion needs attention", deleted: "Data deleted" } as const)[service.dataDeletion.state] : requested ?? stateLabels[service.state]} />
        </div>
      </div>
      {!service.dataDeletion && <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{servicePolicyLabel(service)}</p>
        {service.handoff?.phase === "pending" && <p>Moving the existing command to service supervision. Its stop must be confirmed before the managed service starts.</p>}
        {service.handoff?.phase === "stopped" && service.desiredState === "running" && <p>The original command is stopped. Starting the managed service from the same files.</p>}
        {service.policy.keepRunningUntil && Date.parse(service.policy.keepRunningUntil) > Date.now() && <p>Idle sleep paused until {formatDateTime(service.policy.keepRunningUntil)}.</p>}
        {policy.maxRunningSeconds !== null && <p>Maximum {policy.maxRunningSeconds < 60 ? `${policy.maxRunningSeconds} seconds` : `${Math.ceil(policy.maxRunningSeconds / 60)} minutes`} per start, including active use.{service.companyMaxRunningSeconds === policy.maxRunningSeconds ? " Set by company policy." : ""}</p>}
        {service.stopReason === "company_running_limit" && <p>{service.state === "stopped" ? "Stopped because" : "Stop requested because"} the company running-service limit was lowered.</p>}
        {service.stopReason === "company_maximum_lifetime" && <p>{service.state === "stopped" ? "Stopped after reaching the company maximum running time." : "Stop requested: company maximum running time reached."} An open preview cannot restart it.</p>}
        {service.state === "sleeping" && <p>Files are retained. Open a configured preview or start the service to continue.</p>}
        {service.state === "stopped" && <p>Files are retained. Start explicitly to resume.</p>}
        {service.state === "starting" && <p>Waiting for the application to become ready.</p>}
      </div>}
      {!service.dataDeletion && service.endpoints.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-2" aria-label="Preview endpoints">
          {service.endpoints.map((endpoint) => (
            <li key={endpoint.name} className="flex min-w-0 flex-col gap-1">
              {endpoint.url ? (
                <div className="flex flex-wrap items-center gap-1">
                  <Button variant="outline" size="sm" asChild>
                    <a href={endpoint.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />Open {endpoint.name}</a>
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Copy ${endpoint.name} URL`} onClick={() => void copy(endpoint.name, endpoint.url!)}>
                    {copied === endpoint.name ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  </Button>
                  {copied === endpoint.name && <span className="text-xs text-muted-foreground" role="status">Copied</span>}
                </div>
              ) : (
                <p className="break-words text-xs text-muted-foreground">{endpoint.name}: {endpoint.status === "failed" ? endpoint.error ?? "Preview unavailable" : "Preview is not ready yet"}</p>
              )}
              {endpoint.url && endpoint.status === "failed" && <p className="break-words text-xs text-destructive">{endpoint.error ?? "Preview routing is unavailable. Open the URL to retry."}</p>}
            </li>
          ))}
        </ul>
      )}
      {!service.dataDeletion && detail && service.purpose === "preview" && service.endpoints.some((endpoint) => endpoint.url) && <p className="text-xs text-muted-foreground">
        {service.previewActivity?.lastSignalAt ? `Browser activity last received ${formatDateTime(service.previewActivity.lastSignalAt)}.` : "Waiting for browser activity. App security policies can prevent activity signals; use the lifetime controls if needed."}
      </p>}
      {service.error && <p className="break-words text-xs text-destructive" role="alert">{service.error}</p>}
      {service.retention.error && <p className="break-words text-xs text-destructive" role="alert">{service.retention.error}</p>}
      {copyError && <p className="text-xs text-destructive" role="alert">{copyError}</p>}
      <div className="flex flex-wrap items-center gap-1">
        {canManage && !service.dataDeletion && <>
          {running && service.state !== "failed" ? (
            <Button variant="outline" size="sm" disabled={disabled || service.state === "stopping"} onClick={() => operation.run({ action: "stop" })}><Square aria-hidden="true" />Stop</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={disabled || service.state === "stopping"} onClick={() => operation.run({ action: "start" })}><Play aria-hidden="true" />Start</Button>
          )}
          {service.state === "failed" && <Button variant="outline" size="sm" disabled={disabled} onClick={() => operation.run({ action: "stop" })}><Square aria-hidden="true" />{running ? "Stop" : "Retry stop"}</Button>}
          <Button variant="ghost" size="sm" disabled={disabled || transitioning} onClick={() => operation.run({ action: "restart" })}><RotateCcw aria-hidden="true" />Restart</Button>
        </>}
        <Button variant="ghost" size="sm" aria-expanded={logsOpen} aria-controls={logsId} onClick={() => setLogsOpen(!logsOpen)}><Terminal aria-hidden="true" />{logsOpen ? "Hide logs" : "Logs"}</Button>
      </div>
      {operation.isError && (
        <div className="flex flex-col gap-2 text-xs" role="alert">
          <p className="text-destructive">{operation.ambiguous ? "The request timed out or disconnected. Checking the service’s current state." : operation.error.message}</p>
          {operation.ambiguous && <Button variant="outline" size="sm" className="self-start" disabled={operation.pending} onClick={operation.retryRequest}>Retry same request</Button>}
        </div>
      )}
      {logsOpen && (
        <div id={logsId} className="flex min-w-0 flex-col gap-2">
          {logs.isPending && <p className="text-xs text-muted-foreground" role="status">Loading logs…</p>}
          {logs.isError && <div className="flex flex-wrap items-center gap-2" role="alert"><span className="text-xs text-destructive">Logs could not be refreshed.</span><Button size="xs" variant="outline" onClick={() => void logs.refetch()}>Retry logs</Button></div>}
          {logs.data && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs" tabIndex={0} aria-label={`${service.name} logs`}>{logs.data.text || "No output yet."}</pre>}
        </div>
      )}
    </section>
  );
}

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function RuntimeServicePolicyEditor({ service, disabled }: { service: RuntimeService; disabled?: boolean }) {
  const operation = useRuntimeServiceOperation(service);
  const [editing, setEditing] = useState(false);
  const [idle, setIdle] = useState("");
  const [maximum, setMaximum] = useState("");
  const [keepUntil, setKeepUntil] = useState("");
  const [originalKeepUntil, setOriginalKeepUntil] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editRevision, setEditRevision] = useState(service.revision);
  const [editPolicy, setEditPolicy] = useState(service.policy);
  useEffect(() => {
    if (operation.isSuccess && operation.data) {
      setEditRevision(operation.data.revision);
      setEditPolicy(operation.data.policy);
    }
  }, [operation.isSuccess, operation.data]);
  const formId = useId();
  function open() {
    setIdle(service.policy.idleSeconds === null ? "" : String(service.policy.idleSeconds / 60));
    setMaximum(service.policy.maxRunningSeconds === null ? "" : String(service.policy.maxRunningSeconds / 60));
    setKeepUntil(localDateTime(service.policy.keepRunningUntil));
    setOriginalKeepUntil(service.policy.keepRunningUntil);
    setFormError(null);
    setEditRevision(service.revision);
    setEditPolicy(service.policy);
    operation.reset();
    setEditing(true);
  }
  return (
    <div className="flex flex-col gap-3">
      {!editing ? <Button className="self-start" variant="outline" size="sm" disabled={disabled} onClick={open}>Edit lifetime</Button> : (
        <form className="flex flex-col gap-3" onSubmit={(event) => {
          event.preventDefault();
          // Preserve an unchanged timestamp exactly, including its seconds and
          // offset through a daylight-saving transition.
          let keepRunningUntil = originalKeepUntil;
          if (keepUntil !== localDateTime(originalKeepUntil)) {
            const time = keepUntil ? new Date(keepUntil).getTime() : null;
            if (time !== null && (!Number.isFinite(time) || time <= Date.now())) { setFormError("Choose a future time or clear the keep-running time."); return; }
            keepRunningUntil = time === null ? null : new Date(time).toISOString();
          }
          setFormError(null);
          operation.run({ expectedPolicy: editPolicy, policy: { idleSeconds: idle === "" ? null : Math.round(Number(idle) * 60), maxRunningSeconds: maximum === "" ? null : Math.round(Number(maximum) * 60), keepRunningUntil } }, editRevision);
        }}>
          <fieldset disabled={disabled || operation.pending || operation.ambiguous} className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1.5"><Label htmlFor={`${formId}-idle`}>Sleep after idle minutes</Label><Input id={`${formId}-idle`} type="number" min={1 / 60} max="43200" step="any" value={idle} onChange={(event) => { setIdle(event.target.value); operation.reset(); }} placeholder="No idle shutdown" /><p className="text-xs text-muted-foreground">Leave empty to run until explicitly stopped.</p></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor={`${formId}-max`}>Maximum running minutes</Label><Input id={`${formId}-max`} type="number" min={1 / 60} max="43200" step="any" value={maximum} onChange={(event) => { setMaximum(event.target.value); operation.reset(); }} placeholder="No maximum" /><p className="text-xs text-muted-foreground">Applies even during active use.{service.companyMaxRunningSeconds != null ? ` Company policy caps every start at ${service.companyMaxRunningSeconds / 60} minutes.` : ""}</p></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor={`${formId}-keep`}>Keep running until</Label><Input id={`${formId}-keep`} type="datetime-local" value={keepUntil} aria-describedby={`${formId}-keep-help`} onChange={(event) => { setKeepUntil(event.target.value); setFormError(null); operation.reset(); }} /><p id={`${formId}-keep-help`} className="text-xs text-muted-foreground">Pause idle sleep until this local time. Maximum running time and Stop still apply. Start a stopped service separately; clear this field to resume its idle policy.</p></div>
          </fieldset>
          {formError && <p className="text-xs text-destructive" role="alert">{formError}</p>}
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled || operation.pending || operation.ambiguous}>{operation.pending ? "Saving…" : "Save lifetime"}</Button><Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Close</Button></div>
          {operation.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-xs text-destructive">{operation.ambiguous ? "Could not confirm the save. Retry the same request to find out whether it was accepted." : operation.error.message}</p>{operation.ambiguous ? <Button className="self-start" size="sm" variant="outline" type="button" disabled={operation.pending} onClick={operation.retryRequest}>Retry same request</Button> : <Button className="self-start" size="sm" variant="outline" type="button" onClick={open}>Load current lifetime</Button>}</div>}
          {operation.isSuccess && <p className="text-xs text-muted-foreground" role="status">Lifetime saved.</p>}
        </form>
      )}
    </div>
  );
}
