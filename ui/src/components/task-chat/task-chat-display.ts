import { t } from "@/i18n";

/** Display-only maps. Never feed translated copy back to taxonomy or rotation. */
const STATUS_COPY: Record<string, () => string> = {
  "Responding": () => t("task-chat-ui:status.Responding"),
  "Thinking": () => t("task-chat-ui:status.Thinking"),
  "Running": () => t("task-chat-ui:status.Running"),
  "Working": () => t("task-chat-ui:status.Working"),
  "Queued": () => t("task-chat-ui:status.Queued"),
  "Reconnecting": () => t("task-chat-ui:status.Reconnecting"),
};
export function statusDisplayLabel(identity: string): string {
  return Object.hasOwn(STATUS_COPY, identity) ? STATUS_COPY[identity]() : identity;
}

const WHIMSY_COPY: Record<string, () => string> = {
  "Clipping": () => t("task-chat-ui:whimsy.Clipping"),
  "Organizing": () => t("task-chat-ui:whimsy.Organizing"),
  "Sorting": () => t("task-chat-ui:whimsy.Sorting"),
  "Synthesizing": () => t("task-chat-ui:whimsy.Synthesizing"),
  "Analyzing": () => t("task-chat-ui:whimsy.Analyzing"),
  "Filing": () => t("task-chat-ui:whimsy.Filing"),
  "Collating": () => t("task-chat-ui:whimsy.Collating"),
  "Stapling": () => t("task-chat-ui:whimsy.Stapling"),
  "Indexing": () => t("task-chat-ui:whimsy.Indexing"),
  "Annotating": () => t("task-chat-ui:whimsy.Annotating"),
  "Drafting": () => t("task-chat-ui:whimsy.Drafting"),
  "Proofreading": () => t("task-chat-ui:whimsy.Proofreading"),
  "Alphabetizing": () => t("task-chat-ui:whimsy.Alphabetizing"),
  "Photocopying": () => t("task-chat-ui:whimsy.Photocopying"),
  "Laminating": () => t("task-chat-ui:whimsy.Laminating"),
  "Hole-punching": () => t("task-chat-ui:whimsy.Hole-punching"),
  "Bookmarking": () => t("task-chat-ui:whimsy.Bookmarking"),
  "Highlighting": () => t("task-chat-ui:whimsy.Highlighting"),
  "Typing": () => t("task-chat-ui:whimsy.Typing"),
  "Trimming": () => t("task-chat-ui:whimsy.Trimming"),
  "Aligning": () => t("task-chat-ui:whimsy.Aligning"),
  "Combining": () => t("task-chat-ui:whimsy.Combining"),
  "Whiteboarding": () => t("task-chat-ui:whimsy.Whiteboarding"),
  "Diagramming": () => t("task-chat-ui:whimsy.Diagramming"),
  "Sketching": () => t("task-chat-ui:whimsy.Sketching"),
  "Labeling": () => t("task-chat-ui:whimsy.Labeling"),
  "Sticky-noting": () => t("task-chat-ui:whimsy.Sticky-noting"),
  "Brewing": () => t("task-chat-ui:whimsy.Brewing"),
  "Tinkering": () => t("task-chat-ui:whimsy.Tinkering"),
  "Distilling": () => t("task-chat-ui:whimsy.Distilling"),
  "Deliberating": () => t("task-chat-ui:whimsy.Deliberating"),
};
export function whimsyDisplayLabel(identity: string): string {
  return Object.hasOwn(WHIMSY_COPY, identity) ? WHIMSY_COPY[identity]() : identity;
}

import type { TaskChatToolItem, TaskChatProtocolDetail } from "./task-chat-model";
export function toolDisplayLabel(item: TaskChatToolItem): string {
  if (item.generatedName === "missing") return t("task-chat-ui:tool.unnamed");
  if (item.generatedName === "edit") return t("task-chat-ui:tool.syntheticEdit");
  return item.name;
}
const DETAIL_COPY: Record<string, () => string> = {
  "Revision": () => t("task-chat-ui:detail.Revision"),
  "Sync Status": () => t("task-chat-ui:detail.Sync Status"),
  "Document Revision": () => t("task-chat-ui:detail.Document Revision"),
  "Complete": () => t("task-chat-ui:detail.Complete"),
  "Read Only": () => t("task-chat-ui:detail.Read Only"),
  "Duration Ms": () => t("task-chat-ui:detail.Duration Ms"),
  "Exit Code": () => t("task-chat-ui:detail.Exit Code"),
  "Output Bytes": () => t("task-chat-ui:detail.Output Bytes"),
  "Pattern": () => t("task-chat-ui:detail.Pattern"),
  "Requested Model": () => t("task-chat-ui:detail.Requested Model"),
  "From Model": () => t("task-chat-ui:detail.From Model"),
  "Effective Model": () => t("task-chat-ui:detail.Effective Model"),
  "Buffering": () => t("task-chat-ui:detail.Buffering"),
  "Pre Tokens": () => t("task-chat-ui:detail.Pre Tokens"),
  "Post Tokens": () => t("task-chat-ui:detail.Post Tokens"),
  "Same Session": () => t("task-chat-ui:detail.Same Session"),
  "Reference": () => t("task-chat-ui:detail.Reference"),
  "Media Type": () => t("task-chat-ui:detail.Media Type"),
  "Registered": () => t("task-chat-ui:detail.Registered"),
  "Transparent Background": () => t("task-chat-ui:detail.Transparent Background"),
  "Failure": () => t("task-chat-ui:detail.Failure"),
  "State": () => t("task-chat-ui:detail.State"),
  "Scope": () => t("task-chat-ui:detail.Scope"),
  "Event": () => t("task-chat-ui:detail.Event"),
  "Blocking": () => t("task-chat-ui:detail.Blocking"),
  "Label": () => t("task-chat-ui:detail.Label"),
  "Available": () => t("task-chat-ui:detail.Available"),
  "Decision": () => t("task-chat-ui:detail.Decision"),
  "Target Execution Id": () => t("task-chat-ui:detail.Target Execution Id"),
  "Origin": () => t("task-chat-ui:detail.Origin"),
  "Input Class": () => t("task-chat-ui:detail.Input Class"),
  "Byte Count": () => t("task-chat-ui:detail.Byte Count"),
  "Planned Duration Ms": () => t("task-chat-ui:detail.Planned Duration Ms"),
  "Elapsed Duration Ms": () => t("task-chat-ui:detail.Elapsed Duration Ms"),
  "User Actionable": () => t("task-chat-ui:detail.User Actionable"),

  "Name": () => t("task-chat-ui:detail.Name"),
  "Severity": () => t("task-chat-ui:detail.Severity"),
  "Action": () => t("task-chat-ui:detail.Action"),
  "Query": () => t("task-chat-ui:detail.Query"),
  "Summary": () => t("task-chat-ui:detail.Summary"),
  "Status": () => t("task-chat-ui:detail.Status"),
  "Progress": () => t("task-chat-ui:detail.Progress"),
  "Transport": () => t("task-chat-ui:detail.Transport"),
  "Namespace": () => t("task-chat-ui:detail.Namespace"),
  "Operation": () => t("task-chat-ui:detail.Operation"),
  "Provider": () => t("task-chat-ui:detail.Provider"),
  "Provenance": () => t("task-chat-ui:detail.Provenance"),
  "Category": () => t("task-chat-ui:detail.Category"),
  "Recoverable": () => t("task-chat-ui:detail.Recoverable"),
  "Message": () => t("task-chat-ui:detail.Message"),
  "Type": () => t("task-chat-ui:detail.Type"),
  "Id": () => t("task-chat-ui:detail.Id"),
  "Title": () => t("task-chat-ui:detail.Title"),
  "Path": () => t("task-chat-ui:detail.Path"),
  "Url": () => t("task-chat-ui:detail.Url"),
  "Tool": () => t("task-chat-ui:detail.Tool"),
  "Tool Name": () => t("task-chat-ui:detail.Tool Name"),
  "Source": () => t("task-chat-ui:detail.Source"),
  "Model": () => t("task-chat-ui:detail.Model"),
  "Reason": () => t("task-chat-ui:detail.Reason"),
  "Code": () => t("task-chat-ui:detail.Code"),
  "Session Id": () => t("task-chat-ui:detail.Session Id"),
  "Run Id": () => t("task-chat-ui:detail.Run Id"),
  "Duration": () => t("task-chat-ui:detail.Duration"),
  "Count": () => t("task-chat-ui:detail.Count"),
  "Target": () => t("task-chat-ui:detail.Target"),
  "Description": () => t("task-chat-ui:detail.Description"),
  "Version": () => t("task-chat-ui:detail.Version"),
  "Cwd": () => t("task-chat-ui:detail.Cwd"),
  "Command": () => t("task-chat-ui:detail.Command"),
  "Method": () => t("task-chat-ui:detail.Method"),
  "Endpoint": () => t("task-chat-ui:detail.Endpoint"),
  "Request Id": () => t("task-chat-ui:detail.Request Id"),
  "Result": () => t("task-chat-ui:detail.Result"),
};
export function detailDisplayLabel(detail: TaskChatProtocolDetail): string {
  return detail.labelSource !== "provider" && Object.hasOwn(DETAIL_COPY, detail.label) ? DETAIL_COPY[detail.label]() : detail.label;
}
const ATTACHMENT_COPY: Record<string, () => string> = {
  "File": () => t("task-chat-ui:attachment.File"),
  "Doc": () => t("task-chat-ui:attachment.Doc"),
  "Text": () => t("task-chat-ui:attachment.Text"),
  "Sheet": () => t("task-chat-ui:attachment.Sheet"),
  "Archive": () => t("task-chat-ui:attachment.Archive"),
  "Audio": () => t("task-chat-ui:attachment.Audio"),
  "Video": () => t("task-chat-ui:attachment.Video"),
  "Code": () => t("task-chat-ui:attachment.Code"),
  "Log": () => t("task-chat-ui:attachment.Log"),
  "Patch": () => t("task-chat-ui:attachment.Patch"),
};
/** fileKindForAttachment retains English sentinels for MIME fallback. */
export function attachmentKindDisplayLabel(identity: string): string {
  return Object.hasOwn(ATTACHMENT_COPY, identity) ? ATTACHMENT_COPY[identity]() : identity;
}

const ENUM_COPY: Record<string, () => string> = {
  "pending": () => t("task-chat-ui:enum.pending"),
  "in_progress": () => t("task-chat-ui:enum.in_progress"),
  "completed": () => t("task-chat-ui:enum.completed"),
  "running": () => t("task-chat-ui:enum.running"),
  "failed": () => t("task-chat-ui:enum.failed"),
  "interrupted": () => t("task-chat-ui:enum.interrupted"),
  "informational": () => t("task-chat-ui:enum.informational"),
  "cancelled": () => t("task-chat-ui:enum.cancelled"),
  "expired": () => t("task-chat-ui:enum.expired"),
  "resolved": () => t("task-chat-ui:enum.resolved"),
  "accepted": () => t("task-chat-ui:enum.accepted"),
  "answered": () => t("task-chat-ui:enum.answered"),
  "rejected": () => t("task-chat-ui:enum.rejected"),
  "waiting": () => t("task-chat-ui:enum.waiting"),
  "blocked": () => t("task-chat-ui:enum.blocked"),
  "denied": () => t("task-chat-ui:enum.denied"),
  "allowed": () => t("task-chat-ui:enum.allowed"),
  "approve": () => t("task-chat-ui:enum.approve"),
  "reject": () => t("task-chat-ui:enum.reject"),
  "revise": () => t("task-chat-ui:enum.revise"),
  "comment": () => t("task-chat-ui:enum.comment"),
  "high": () => t("task-chat-ui:enum.high"),
  "medium": () => t("task-chat-ui:enum.medium"),
  "low": () => t("task-chat-ui:enum.low"),
  "create": () => t("task-chat-ui:enum.create"),
  "modify": () => t("task-chat-ui:enum.modify"),
  "delete": () => t("task-chat-ui:enum.delete"),
  "rename": () => t("task-chat-ui:enum.rename"),
  "copy": () => t("task-chat-ui:enum.copy"),
  "add": () => t("task-chat-ui:enum.add"),
  "remove": () => t("task-chat-ui:enum.remove"),
  "generic": () => t("task-chat-ui:enum.generic"),
  "code": () => t("task-chat-ui:enum.code"),
  "text": () => t("task-chat-ui:enum.text"),
  "image": () => t("task-chat-ui:enum.image"),
  "document": () => t("task-chat-ui:enum.document"),
  "markdown": () => t("task-chat-ui:enum.markdown"),
  "pdf": () => t("task-chat-ui:enum.pdf"),
  "active": () => t("task-chat-ui:enum.active"),
  "paused": () => t("task-chat-ui:enum.paused"),
  "complete": () => t("task-chat-ui:enum.complete"),
  "limited": () => t("task-chat-ui:enum.limited"),
  "usage_limited": () => t("task-chat-ui:enum.usage_limited"),
  "stopped": () => t("task-chat-ui:enum.stopped"),
  "off": () => t("task-chat-ui:enum.off"),
  "minimal": () => t("task-chat-ui:enum.minimal"),
  "xhigh": () => t("task-chat-ui:enum.xhigh"),
  "max": () => t("task-chat-ui:enum.max"),
  "ultra": () => t("task-chat-ui:enum.ultra"),
};
/** Translate owned enums in text cells only. Callers retain their existing unknown fallback. */
export function enumDisplayLabel(identity: string, fallback = identity): string {
  return Object.hasOwn(ENUM_COPY, identity) ? ENUM_COPY[identity]() : fallback;
}

const EFFORT_COPY: Record<string, () => string> = {
  "off": () => t("task-chat-ui:effort.off"),
  "minimal": () => t("task-chat-ui:effort.minimal"),
  "low": () => t("task-chat-ui:effort.low"),
  "medium": () => t("task-chat-ui:effort.medium"),
  "high": () => t("task-chat-ui:effort.high"),
  "xhigh": () => t("task-chat-ui:effort.xhigh"),
  "max": () => t("task-chat-ui:effort.max"),
  "ultra": () => t("task-chat-ui:effort.ultra"),
};
export function effortDisplayLabel(identity: string, fallback: string): string {
  return Object.hasOwn(EFFORT_COPY, identity) ? EFFORT_COPY[identity]() : fallback;
}
