export interface NotificationPublicFrame {
  eventId: number; companyId: string; taskId: string; actorType: "user" | "agent"; actorId: string;
  eventCreatedAt: string; eligible: boolean; at: number;
}
export interface NotificationBoundFrame {
  principalId: string; commentId: string; taskId: string; eligible: boolean; at: number;
  eventId: number; activityId: string; actorType: "user" | "agent"; actorId: string;
  eventCreatedAt: string; activityCreatedAt: string; commentCreatedAt: string;
}
export interface NotificationObserverInput {
  principalId: string; sessionPrincipalId: string; frames: NotificationPublicFrame[]; overflow: boolean;
  baselineActivityIds: string[]; baselineCommentIds: string[];
  activity: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>>;
}
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const time = (v: unknown) => typeof v === "string" ? Date.parse(v) : NaN;
export function publicNotificationFrame(value: unknown, companyId: string, taskId: string, at: number): NotificationPublicFrame | null {
  const message = value as Record<string, unknown> | null;
  const payload = message?.payload as Record<string, unknown> | undefined;
  if (!message || !payload || message.companyId !== companyId || message.type !== "activity.logged" || payload.action !== "issue.comment_added"
    || payload.entityType !== "issue" || payload.entityId !== taskId || !Number.isSafeInteger(message.id) || Number(message.id) <= 0
    || !["user", "agent"].includes(String(payload.actorType)) || !nonempty(payload.actorId) || typeof message.toastEligible !== "boolean"
    || !Number.isFinite(time(message.createdAt)) || !Number.isFinite(at) || at < time(message.createdAt)) return null;
  return { eventId: Number(message.id), companyId, taskId, actorType: payload.actorType as "user" | "agent", actorId: payload.actorId,
    eventCreatedAt: String(message.createdAt), eligible: message.toastEligible, at };
}
export function bindNotificationPublicEvents(companyId: string, taskId: string, observers: [NotificationObserverInput, NotificationObserverInput]) {
  const reject = (reason: string) => ({ complete: false, reason, frames: [[], []] as NotificationBoundFrame[][] });
  if (!companyId || !taskId || observers[0].principalId === observers[1].principalId
    || observers.some(o => !o.principalId || o.principalId !== o.sessionPrincipalId || o.overflow)) return reject("principal-or-capture-invalid");
  if (observers.some(o => o.baselineCommentIds.length || o.activity.some(a => o.baselineActivityIds.includes(String(a.id)) && a.entityType === "issue" && a.entityId === taskId && a.action === "issue.comment_added"))) return reject("not-a-fresh-comment-boundary");
  const normalized = [];
  for (const observer of observers) {
    if (new Set(observer.frames.map(f => f.eventId)).size !== observer.frames.length) return reject("duplicate-public-event");
    if (observer.frames.some(f => f.companyId !== companyId || f.taskId !== taskId || !Number.isSafeInteger(f.eventId) || f.eventId <= 0
      || !["user", "agent"].includes(f.actorType) || !f.actorId || typeof f.eligible !== "boolean" || !Number.isFinite(time(f.eventCreatedAt))
      || !Number.isFinite(f.at) || f.at < time(f.eventCreatedAt))) return reject("public-event-scope-invalid");
    const comments = observer.comments.filter(c => !observer.baselineCommentIds.includes(String(c.id)) && c.companyId === companyId && c.issueId === taskId);
    const activity = observer.activity.filter(a => !observer.baselineActivityIds.includes(String(a.id)) && a.companyId === companyId
      && a.entityType === "issue" && a.entityId === taskId && a.action === "issue.comment_added");
    if (new Set(comments.map(c => c.id)).size !== comments.length || new Set(activity.map(a => a.id)).size !== activity.length) return reject("duplicate-saved-evidence");
    const rows = [];
    for (const a of activity) {
      const commentId = (a.details as Record<string, unknown> | undefined)?.commentId;
      const c = comments.find(c => c.id === commentId);
      if (!nonempty(a.id) || !nonempty(commentId) || !["user", "agent"].includes(String(a.actorType)) || !nonempty(a.actorId) || !c || c.deletedAt
        || (a.actorType === "agent" ? c.authorAgentId !== a.actorId || !!c.authorUserId : c.authorUserId !== a.actorId || !!c.authorAgentId)
        || !Number.isFinite(time(a.createdAt)) || !Number.isFinite(time(c.createdAt)) || time(c.createdAt) > time(a.createdAt)) return reject("saved-comment-audit-binding-invalid");
      rows.push({ activityId: a.id, commentId, actorType: a.actorType as "user" | "agent", actorId: a.actorId,
        activityCreatedAt: String(a.createdAt), commentCreatedAt: String(c.createdAt) });
    }
    if (rows.length !== comments.length || new Set(rows.map(r => r.commentId)).size !== rows.length) return reject("saved-comment-audit-not-bijective");
    normalized.push({ rows, frames: [...observer.frames].sort((a,b) => a.eventId-b.eventId) });
  }
  const [left, right] = normalized as [typeof normalized[number], typeof normalized[number]];
  if (!left.rows.length || !left.frames.length) return reject("no-new-comment-events");
  const sortRows = (rows: typeof left.rows) => [...rows].sort((a,b) => time(a.activityCreatedAt)-time(b.activityCreatedAt));
  if (JSON.stringify(sortRows(left.rows)) !== JSON.stringify(sortRows(right.rows)) || left.frames.length !== right.frames.length
    || left.frames.some((f,i) => { const g = right.frames[i]; return !g || f.eventId !== g.eventId || f.actorType !== g.actorType
      || f.actorId !== g.actorId || f.eventCreatedAt !== g.eventCreatedAt; })) return reject("principals-did-not-observe-same-complete-events");
  const bound: NotificationBoundFrame[][] = [[], []];
  const actors = new Set(left.rows.map(r => `${r.actorType}:${r.actorId}`));
  for (const frame of left.frames) actors.add(`${frame.actorType}:${frame.actorId}`);
  for (const actor of actors) {
    const rows = sortRows(left.rows.filter(r => `${r.actorType}:${r.actorId}` === actor));
    const events = left.frames.filter(f => `${f.actorType}:${f.actorId}` === actor);
    if (rows.length !== events.length || rows.some((r,i) => i > 0 && (time(r.activityCreatedAt) <= time(rows[i-1]!.activityCreatedAt)
      || time(r.commentCreatedAt) <= time(rows[i-1]!.commentCreatedAt))) || events.some((f,i) => i > 0 && time(f.eventCreatedAt) <= time(events[i-1]!.eventCreatedAt))) return reject("actor-event-order-ambiguous");
    for (const [i, row] of rows.entries()) {
      const event = events[i]!;
      if (time(event.eventCreatedAt) < time(row.activityCreatedAt)) return reject("event-precedes-saved-activity");
      for (const [index, observer] of observers.entries()) {
        const actual = observer.frames.find(f => f.eventId === event.eventId)!;
        bound[index]!.push({ principalId: observer.principalId, commentId: row.commentId, taskId, eligible: actual.eligible, at: actual.at,
          eventId: actual.eventId, activityId: row.activityId, actorType: row.actorType, actorId: row.actorId,
          eventCreatedAt: actual.eventCreatedAt, activityCreatedAt: row.activityCreatedAt, commentCreatedAt: row.commentCreatedAt });
      }
    }
  }
  return { complete: true, reason: null, frames: bound };
}
