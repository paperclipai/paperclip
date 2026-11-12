import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

type Columns = { id: SQLWrapper; companyId: SQLWrapper; endpointId: SQLWrapper; kind: SQLWrapper; status: SQLWrapper; payload: SQLWrapper; result: SQLWrapper };
function objectKeys(value: SQL, keys: readonly string[]): SQL {
  return sql`jsonb_typeof(${value}) = 'object' AND ${value} ?& ${[...keys]}::text[]
    AND (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(${value})='object' THEN ${value} ELSE '{}'::jsonb END)) = ${keys.length}`;
}
export function completedSlackFormSessionSql(action: Columns): SQL {
  const p = sql`${action.payload}`, r = sql`${action.result}`, work = sql`(${r}->'formAck')`, receipt = sql`(${work}->'receipt')`,
    binding = sql`(${p}->'binding')`, proof = sql`(${r}->'cloudProofAcceptance')`, intent = sql`(${r}->'terminalIntent')`, view = sql`(${intent}->'view')`;
  const digest = sql`encode(sha256(convert_to('[' || to_json(${view}->>'id')::text || ',' || to_json(${view}->>'hash')::text || ',' || to_json(${view}->>'externalId')::text || ']', 'UTF8')), 'hex')`;
  return sql`coalesce(${action.kind}='slack_form_session' AND (${action.status} IN ('processed','cancelled') OR (${action.status}='failed' AND ${receipt}->>'outcome'='no_effect'))
    AND ${r}->'nextAttemptAt' = 'null'::jsonb
    AND ${objectKeys(work, ['version','phase','leaseId','deliveryId','receiptJws','receipt'])}
    AND ${work}->'version' = '1'::jsonb AND ${work}->>'phase'='transferred'
    AND jsonb_typeof(${work}->'receiptJws')='string' AND length(${work}->>'receiptJws') BETWEEN 1 AND 12000
    AND ${work}->>'receiptJws' ~ '^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
    AND ${objectKeys(receipt, ['version','kind','binding','environment','operationId','deliveryId','appReceiptId','grantId','publicationId','interactionId','userId','viewDigest','terminalDigest','outcome','finalizedAt'])}
    AND ${receipt}->'version'='1'::jsonb AND ${receipt}->>'kind'='slack_form_finalized'
    AND ${objectKeys(binding, ['version','instanceId','companyId','endpointId','publicId','connectionId','runtimeGeneration','teamId','appId','eventBindingId','credentialFingerprint'])}
    AND ${binding}->'version'='1'::jsonb AND jsonb_typeof(${binding}->'runtimeGeneration')='number'
    AND ${binding}->>'runtimeGeneration' ~ '^[1-9][0-9]{0,15}$'
    AND (length(${binding}->>'runtimeGeneration') < 16 OR ${binding}->>'runtimeGeneration' <= '9007199254740991')
    AND ${binding}->>'publicId' ~ '^[A-Za-z0-9_-]{43}$' AND ${binding}->>'teamId' ~ '^T[A-Z0-9]+$' AND ${binding}->>'appId' ~ '^A[A-Z0-9]+$'
    AND ${binding}->>'eventBindingId' ~ '^slack-event:[a-f0-9]{64}$' AND ${binding}->>'credentialFingerprint' ~ '^[a-f0-9]{64}$'
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['instanceId','companyId','endpointId','publicId','connectionId','teamId','appId','eventBindingId','credentialFingerprint']) key
      WHERE jsonb_typeof(${binding}->key) IS DISTINCT FROM 'string' OR length(${binding}->>key) NOT BETWEEN 1 AND 200)
    AND ${objectKeys(proof, ['version','binding','operationId','appReceiptId','outcome','terminalDigest','acceptedAt'])}
    AND ${proof}->'version'='1'::jsonb AND ${receipt}->'binding'=${binding} AND ${proof}->'binding'=${binding}
    AND ${proof}->>'acceptedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
    AND ${receipt}->>'finalizedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
    AND ${receipt}->>'environment' IN ('development','test','staging','production')
    AND ${binding}->>'companyId'=${action.companyId}::text AND ${binding}->>'endpointId'=${action.endpointId}::text
    AND ${receipt}->>'appReceiptId'=${action.id}::text AND ${proof}->>'appReceiptId'=${action.id}::text AND ${intent}->>'appReceiptId'=${action.id}::text
    AND ${receipt}->'environment'=${p}->'environment'
    AND ${receipt}->'operationId'=${p}->'operationId' AND ${receipt}->'operationId'=${intent}->'operationId' AND ${receipt}->'operationId'=${proof}->'operationId'
    AND ${receipt}->>'operationId' ~ '^[a-f0-9]{64}$' AND ${receipt}->>'deliveryId'='slack_form_'||(${receipt}->>'operationId')
    AND ${receipt}->'deliveryId'=${intent}->'deliveryId' AND ${receipt}->'deliveryId'=${work}->'deliveryId'
    AND ${receipt}->'grantId'=${p}->'grantId' AND ${receipt}->'publicationId'=${p}->'publicationId' AND ${receipt}->'interactionId'=${p}->'interactionId'
    AND ${receipt}->'userId'=${p}->'userId' AND ${receipt}->'outcome'=${intent}->'outcome' AND ${receipt}->'outcome'=${proof}->'outcome'
    AND ${receipt}->'terminalDigest'=${proof}->'terminalDigest' AND ${receipt}->>'terminalDigest' ~ '^[a-f0-9]{64}$'
    AND ${r}->>'phase'=CASE WHEN ${receipt}->>'outcome'='no_effect' THEN 'not_opened' ELSE ${receipt}->>'outcome' END
    AND CASE WHEN ${intent}->>'outcome'='no_effect' THEN ${view}='null'::jsonb AND ${receipt}->'viewDigest'='null'::jsonb
      WHEN ${intent}->>'outcome' IN ('submitted','closed') THEN ${objectKeys(view, ['id','hash','externalId'])}
        AND jsonb_typeof(${view}->'id')='string' AND jsonb_typeof(${view}->'hash')='string' AND jsonb_typeof(${view}->'externalId')='string'
        AND ${receipt}->>'viewDigest'=${digest} ELSE false END, false)`;
}
