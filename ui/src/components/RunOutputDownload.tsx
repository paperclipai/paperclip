import type { RunOutputBodyReference } from "@paperclipai/shared";

export function RunOutputDownload({ runId, payload }: { runId: string; payload: unknown }) {
  if (!payload || typeof payload !== "object") return null;
  const event = (payload as Record<string, unknown>).prpEvent;
  if (!event || typeof event !== "object") return null;
  const content = (event as Record<string, unknown>).payload;
  if (!content || typeof content !== "object") return null;
  const ref = (content as Record<string, unknown>).outputBody as RunOutputBodyReference | undefined;
  if (ref?.schema !== "paperclip.output.body.v1" || !/^[a-f0-9]{64}$/.test(ref.bodyId)) return null;
  return <a className="text-primary underline shrink-0" href={`/api/heartbeat-runs/${encodeURIComponent(runId)}/output-bodies/${ref.bodyId}`} download>Download full output</a>;
}
