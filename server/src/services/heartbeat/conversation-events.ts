import { sql } from "drizzle-orm";
import { heartbeatRunEvents } from "@paperclipai/db";

/**
 * Canonical PRP conversation data, excluding historical tool activity.
 * Keep request lifecycles so a cold open cannot hide a question or approval.
 * Item identity may occur on started/completed rather than each text delta.
 */
export function conversationEventCondition(runId: string) {
  return sql`(
    ${heartbeatRunEvents.eventType} like 'runtime_request.%'
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
