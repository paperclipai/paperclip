import { getTableColumns, sql } from "drizzle-orm";
import { heartbeatRunEvents } from "@paperclipai/db";

function planWriteCondition(runId: string) {
  return sql`(${heartbeatRunEvents.eventType} = 'item.completed'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,sourceKind}' = 'runner'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,schema}' = 'paperclip.prp.event.v1'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,type}' = 'tool_result'
      and coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,isError}', ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,is_error}', 'false') = 'false'
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,result,disposition}' in ('applied', 'duplicate')
      and ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,result,document,key}' = 'plan'
      and length(coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,tool_use_id}', ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,id}')) between 1 and 512
      and (
        coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,tool_use_id}', ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,item,id}'),
        coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,turnId}', ''),
        coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,normalizedSessionId}', ''),
        coalesce(${heartbeatRunEvents.payload} #>> '{prpEvent,sourceInstanceId}', '')
      ) in (
        select e.payload #>> '{prpEvent,payload,item,id}',
          coalesce(e.payload #>> '{prpEvent,turnId}', ''),
          coalesce(e.payload #>> '{prpEvent,normalizedSessionId}', ''),
          coalesce(e.payload #>> '{prpEvent,sourceInstanceId}', '')
        from heartbeat_run_events e
        where e.run_id = ${runId}
          and e.event_type = 'item.started'
          and e.payload #>> '{prpEvent,sourceKind}' = 'runner'
          and e.payload #>> '{prpEvent,schema}' = 'paperclip.prp.event.v1'
          and e.payload #>> '{prpEvent,payload,item,type}' = 'tool_use'
          and e.payload #>> '{prpEvent,payload,item,name}' = 'write_document'
          and e.payload #>> '{prpEvent,payload,item,input,key}' = 'plan'
      ))`;
}

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
      ${planWriteCondition(runId)}
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

/** Project Plan receipts inside PostgreSQL, before large tool bodies cross the wire. */
export function conversationEventColumns(runId: string) {
  const planReceipt = planWriteCondition(runId);
  const envelope = sql`${heartbeatRunEvents.payload} -> 'prpEvent'`;
  const item = sql`${heartbeatRunEvents.payload} #> '{prpEvent,payload,item}'`;
  const itemId = sql`coalesce(${item} ->> 'tool_use_id', ${item} ->> 'id')`;
  return {
    ...getTableColumns(heartbeatRunEvents),
    message: sql<string | null>`case when ${planReceipt} then null else ${heartbeatRunEvents.message} end`,
    payload: sql<Record<string, unknown> | null>`case when ${planReceipt} then
      jsonb_build_object('prpEvent', jsonb_strip_nulls(jsonb_build_object(
        'schema', ${envelope} -> 'schema',
        'sourceEventId', ${envelope} -> 'sourceEventId',
        'sourceSeq', ${envelope} -> 'sourceSeq',
        'sourceInstanceId', ${envelope} -> 'sourceInstanceId',
        'sourceKind', ${envelope} -> 'sourceKind',
        'runId', ${envelope} -> 'runId',
        'turnId', ${envelope} -> 'turnId',
        'itemId', ${envelope} -> 'itemId',
        'normalizedSessionId', ${envelope} -> 'normalizedSessionId',
        'eventType', ${envelope} -> 'eventType',
        'schemaVersion', ${envelope} -> 'schemaVersion',
        'priority', ${envelope} -> 'priority',
        'emittedAt', ${envelope} -> 'emittedAt',
        'payload', jsonb_build_object('kind', 'tool_result', 'item', jsonb_build_object(
          'id', ${itemId}, 'tool_use_id', ${itemId}, 'type', 'tool_result',
          'name', 'write_document', 'input', jsonb_build_object('key', 'plan'),
          'result', jsonb_build_object('disposition', ${item} #> '{result,disposition}',
            'document', jsonb_build_object('key', 'plan'))
        ))
      ))) else ${heartbeatRunEvents.payload} end`.mapWith(heartbeatRunEvents.payload),
  };
}
