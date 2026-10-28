import { sql } from "drizzle-orm";
import { heartbeatRunEvents } from "@paperclipai/db";

/**
 * Canonical PRP conversation data, excluding ordinary historical tool activity.
 * Successful document writes retain a body-free boundary for saved Plan cards.
 * Keep request lifecycles so a cold open cannot hide a question or approval.
 * Item identity may occur on started/completed rather than each text delta.
 */
export function conversationEventCondition(runId: string) {
  return sql`(
    ${heartbeatRunEvents.eventType} like 'runtime_request.%'
    or (
      ${heartbeatRunEvents.eventType} = 'tool.execution.completed'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,sourceKind}' = 'runner'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,schema}' = 'paperclip.tool.execution.v1'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,name}' = 'write_document'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,status}' = 'completed'
      and length(${heartbeatRunEvents.payload} #>> '{prpEvent,payload,executionId}') between 1 and 512
    )
    or ${heartbeatRunEvents.eventType} in ('run.result.accepted', 'run.terminal', 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted')
    or (
      ${heartbeatRunEvents.eventType} in ('item.started', 'item.delta', 'item.completed')
      and (lower(replace(coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,payload,kind}', ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,kind}', ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,type}', ''), '_', '')) in ('agentmessage', 'assistantmessage')
      or coalesce(
        ${heartbeatRunEvents.payload} #>> '{prpEvent,itemId}',
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,itemId}',
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,id}',
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,id}'
      ) in (
        select coalesce(e.payload #>> '{prpEvent,itemId}', e.payload #>> '{prpEvent,payload,itemId}', e.payload #>> '{prpEvent,payload,item,id}', e.payload #>> '{prpEvent,payload,id}')
        from heartbeat_run_events e
        where e.run_id = ${runId}
          and e.event_type in ('item.started', 'item.delta', 'item.completed')
          and lower(replace(coalesce(e.payload #>> '{prpEvent,payload,kind}', e.payload #>> '{prpEvent,payload,item,kind}', e.payload #>> '{prpEvent,payload,item,type}', ''), '_', '')) in ('agentmessage', 'assistantmessage')
      ))
    )
  )`;
}

export function projectConversationEvent<T extends {
  eventType: string;
  payload: Record<string, unknown> | null;
  message: string | null;
}>(event: T): T {
  if (event.eventType !== "tool.execution.completed") return event;
  const envelope = event.payload?.prpEvent as Record<string, unknown>;
  const payload = envelope.payload as Record<string, unknown>;
  const metadata = Object.fromEntries([
    "schema", "sourceEventId", "sourceSeq", "sourceInstanceId", "sourceKind",
    "runId", "turnId", "normalizedSessionId", "eventType", "schemaVersion", "priority", "emittedAt",
  ].filter(key => envelope[key] !== undefined).map(key => [key, envelope[key]]));
  return {
    ...event,
    message: null,
    payload: { prpEvent: { ...metadata, payload: {
      schema: payload.schema, executionId: payload.executionId, name: payload.name, status: payload.status,
      conversationProjection: "document_write_boundary",
    } } },
  };
}
