import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Reconstructed independent verifier, not the historical live-proof command.
// No application service, Drizzle schema, payload decoder or digest helper is imported.
const DATABASE_ENV = 'PAPERCLIP_NATIVE_INGESTION_VERIFY_DATABASE_URL';
const ORIGINAL_JSON_KEY = '$paperclipRunEventJsonV1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class VerificationError extends Error {
  constructor(code) { super(code); this.name = 'VerificationError'; this.code = code; }
}
const requireCondition = (value, code) => { if (!value) throw new VerificationError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function integer(value, code, minimum = 0) {
  requireCondition(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value), code);
  const number = Number(value);
  requireCondition(Number.isSafeInteger(number) && number >= minimum, code);
  return number;
}

export function decodeStoredPayload(raw) {
  let decoded;
  try {
    decoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
    requireCondition(object(decoded), 'payload_not_an_object');
    if (Object.hasOwn(decoded, ORIGINAL_JSON_KEY)) {
      requireCondition(typeof decoded[ORIGINAL_JSON_KEY] === 'string', 'invalid_encoded_payload');
      decoded = JSON.parse(decoded[ORIGINAL_JSON_KEY]);
      requireCondition(object(decoded), 'invalid_encoded_payload');
    }
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('invalid_payload_json');
  }
  return decoded;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value)) {
    const fields = Object.entries(value).filter(([, entry]) => entry !== undefined);
    fields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return '{' + fields.map(([key, entry]) => JSON.stringify(key) + ':' + canonicalJson(entry)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export const canonicalSha256 = value => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

function receivedProjection(sequences) {
  const sorted = [...sequences].sort((left, right) => left - right);
  let contiguous = 0;
  const ranges = [];
  for (const sequence of sorted) {
    if (sequence === contiguous + 1 && ranges.length === 0) contiguous = sequence;
    else if (ranges.at(-1)?.endSeq === sequence - 1) ranges.at(-1).endSeq = sequence;
    else ranges.push({ startSeq: sequence, endSeq: sequence });
  }
  return { contiguousSourceSeq: contiguous, ranges };
}

export function verifySnapshot({ companyId, run, events, cursors, ranges }) {
  requireCondition(run?.company_id === companyId, 'run_company_binding_mismatch');
  const nextEventSeq = integer(run.next_event_seq, 'invalid_next_event_seq', 1);
  const marker = integer(run.event_cursor_projection_seq, 'invalid_projection_marker');
  requireCondition(marker < nextEventSeq, 'projection_marker_beyond_run');
  const projectionCurrent = marker === nextEventSeq - 1;
  const globalSequences = new Set(), sourceEvents = new Set(), sources = new Map();
  let canonicalPayloadDigestsVerified = 0, encodedPayloadsDecoded = 0;
  for (const row of events) {
    requireCondition(row.company_id === companyId && row.run_id === run.id && row.agent_id === run.agent_id,
      'event_run_binding_mismatch');
    const sequence = integer(row.seq, 'invalid_global_sequence', 1);
    requireCondition(sequence < nextEventSeq && !globalSequences.has(sequence), 'global_sequence_conflict');
    globalSequences.add(sequence);
    const metadata = [row.source_instance_id, row.source_event_id, row.source_seq,
      row.source_payload_sha256, row.protocol_schema_version];
    if (metadata.every(value => value === null || value === undefined)) continue;
    requireCondition(metadata.every(value => value !== null && value !== undefined), 'partial_source_metadata');
    requireCondition(typeof row.source_instance_id === 'string' && row.source_instance_id.length > 0
      && typeof row.source_event_id === 'string' && row.source_event_id.length > 0, 'invalid_source_identity');
    const sourceSeq = integer(row.source_seq, 'invalid_source_sequence', 1);
    const version = integer(row.protocol_schema_version, 'invalid_protocol_version', 1);
    requireCondition(!sourceEvents.has(row.source_event_id), 'source_event_identity_conflict');
    sourceEvents.add(row.source_event_id);
    let source = sources.get(row.source_instance_id);
    if (!source) sources.set(row.source_instance_id, source = new Set());
    requireCondition(!source.has(sourceSeq), 'source_sequence_identity_conflict');
    source.add(sourceSeq);
    const raw = typeof row.payload_text === 'string' ? row.payload_text : row.payload;
    const projected = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
    if (object(projected) && Object.hasOwn(projected, ORIGINAL_JSON_KEY)) encodedPayloadsDecoded++;
    const event = decodeStoredPayload(raw).prpEvent;
    requireCondition(object(event), 'missing_prp_envelope');
    requireCondition(event.runId === run.id && event.sourceInstanceId === row.source_instance_id
      && event.sourceEventId === row.source_event_id && event.sourceSeq === sourceSeq
      && event.schemaVersion === version && event.eventType === row.event_type, 'envelope_metadata_mismatch');
    requireCondition(typeof row.source_payload_sha256 === 'string'
      && canonicalSha256(event) === row.source_payload_sha256, 'canonical_digest_mismatch');
    canonicalPayloadDigestsVerified++;
  }
  requireCondition(globalSequences.size === nextEventSeq - 1, 'global_sequence_gap_in_complete_fixture');
  const sourceProofs = [...sources].map(([sourceInstanceId, sequences]) => ({ sourceInstanceId, events: sequences.size }));
  if (projectionCurrent) {
    const storedCursors = new Map(), storedRanges = new Map();
    for (const row of cursors) {
      requireCondition(row.company_id === companyId && row.run_id === run.id, 'cursor_run_binding_mismatch');
      requireCondition(!storedCursors.has(row.source_instance_id), 'duplicate_source_cursor');
      storedCursors.set(row.source_instance_id, {
        contiguousSourceSeq: integer(row.contiguous_source_seq, 'invalid_stored_cursor'),
        pendingRangeCount: integer(row.pending_range_count, 'invalid_stored_range_count'),
      });
    }
    for (const row of ranges) {
      requireCondition(row.company_id === companyId && row.run_id === run.id, 'range_run_binding_mismatch');
      requireCondition(storedCursors.has(row.source_instance_id), 'range_without_cursor');
      const range = { startSeq: integer(row.start_seq, 'invalid_range_start', 1), endSeq: integer(row.end_seq, 'invalid_range_end', 1) };
      requireCondition(range.endSeq >= range.startSeq, 'invalid_stored_range');
      const list = storedRanges.get(row.source_instance_id) ?? [];
      list.push(range); storedRanges.set(row.source_instance_id, list);
    }
    for (const sourceInstanceId of new Set([...sources.keys(), ...storedCursors.keys()])) {
      const expected = receivedProjection(sources.get(sourceInstanceId) ?? new Set());
      const actual = storedCursors.get(sourceInstanceId);
      requireCondition(actual?.contiguousSourceSeq === expected.contiguousSourceSeq
        && actual?.pendingRangeCount === expected.ranges.length, 'source_cursor_mismatch');
      const actualRanges = (storedRanges.get(sourceInstanceId) ?? []).sort((left, right) => left.startSeq - right.startSeq);
      requireCondition(JSON.stringify(actualRanges) === JSON.stringify(expected.ranges), 'source_ranges_mismatch');
      let proof = sourceProofs.find(value => value.sourceInstanceId === sourceInstanceId);
      if (!proof) sourceProofs.push(proof = { sourceInstanceId, events: 0 });
      Object.assign(proof, { contiguousSourceSeq: expected.contiguousSourceSeq, pendingRanges: expected.ranges });
    }
  }
  return {
    runId: run.id, companyId, status: run.status, nextEventSeq, eventCursorProjectionSeq: marker,
    eventCursorRebuildPending: run.event_cursor_rebuild_pending, globalEvents: globalSequences.size,
    canonicalPayloadDigestsVerified, encodedPayloadsDecoded,
    projectionChecked: projectionCurrent,
    projectionStatus: projectionCurrent ? 'matches_retained_complete_fixture_history' : 'not_checked_stale_marker',
    sources: sourceProofs.sort((left, right) => left.sourceInstanceId.localeCompare(right.sourceInstanceId)),
  };
}

function selfTest() {
  const companyId = '00000000-0000-0000-0000-000000000001';
  const run = { id: '00000000-0000-0000-0000-000000000002', company_id: companyId,
    agent_id: '00000000-0000-0000-0000-000000000003', next_event_seq: '4',
    event_cursor_projection_seq: '3', event_cursor_rebuild_pending: false, status: 'succeeded' };
  const events = [1, 3, 4].map((sourceSeq, index) => {
    const event = { runId: run.id, sourceInstanceId: 'source-a', sourceEventId: 'event-' + sourceSeq,
      sourceSeq, schemaVersion: 1, eventType: 'item.delta', payload: { text: 'text\u0000with nul', '10': 'ten', '2': 'two' } };
    // Literal canonical text is independently specified, not generated by the encoder under test.
    const expected = '{"eventType":"item.delta","payload":{"10":"ten","2":"two","text":"text\\u0000with nul"},"runId":"' + run.id
      + '","schemaVersion":1,"sourceEventId":"event-' + sourceSeq + '","sourceInstanceId":"source-a","sourceSeq":' + sourceSeq + '}';
    const payload = { prpEvent: event, [ORIGINAL_JSON_KEY]: 'an original user value' };
    return { company_id: companyId, run_id: run.id, agent_id: run.agent_id, seq: String(index + 1),
      event_type: event.eventType, source_instance_id: event.sourceInstanceId, source_event_id: event.sourceEventId,
      source_seq: String(sourceSeq), protocol_schema_version: 1,
      source_payload_sha256: createHash('sha256').update(expected).digest('hex'),
      payload_text: JSON.stringify({ prpEvent: { displayProjection: true }, [ORIGINAL_JSON_KEY]: JSON.stringify(payload) }) };
  });
  const cursor = { company_id: companyId, run_id: run.id, source_instance_id: 'source-a', contiguous_source_seq: '1', pending_range_count: 1 };
  const range = { company_id: companyId, run_id: run.id, source_instance_id: 'source-a', start_seq: '3', end_seq: '4' };
  const fixture = { companyId, run, events, cursors: [cursor], ranges: [range] };
  assert.equal(verifySnapshot(fixture).canonicalPayloadDigestsVerified, 3);
  assert.equal(verifySnapshot(fixture).encodedPayloadsDecoded, 3);
  assert.equal(decodeStoredPayload(events[0].payload_text)[ORIGINAL_JSON_KEY], 'an original user value');
  assert.equal(canonicalJson({ b: [2, 1], a: 'é', '2': 2, '10': 10 }), '{"10":10,"2":2,"a":"é","b":[2,1]}');
  const fails = (snapshot, code) => assert.throws(() => verifySnapshot(snapshot), error => error.code === code);
  fails({ ...fixture, companyId: 'another-company' }, 'run_company_binding_mismatch');
  fails({ ...fixture, events: [{ ...events[0], company_id: 'another-company' }, ...events.slice(1)] }, 'event_run_binding_mismatch');
  fails({ ...fixture, events: [{ ...events[0], source_payload_sha256: 'bad' }, ...events.slice(1)] }, 'canonical_digest_mismatch');
  fails({ ...fixture, events: [...events, events[0]] }, 'global_sequence_conflict');
  fails({ ...fixture, events: events.slice(1) }, 'global_sequence_gap_in_complete_fixture');
  fails({ ...fixture, cursors: [{ ...cursor, contiguous_source_seq: 4 }] }, 'source_cursor_mismatch');
  fails({ ...fixture, ranges: [{ ...range, end_seq: 5 }] }, 'source_ranges_mismatch');
  const fourth = { runId: run.id, sourceInstanceId: 'source-b', sourceEventId: 'other-event',
    sourceSeq: 2, schemaVersion: 1, eventType: 'item.delta', payload: { text: 'other' } };
  const fourthCanonical = '{"eventType":"item.delta","payload":{"text":"other"},"runId":"' + run.id
    + '","schemaVersion":1,"sourceEventId":"other-event","sourceInstanceId":"source-b","sourceSeq":2}';
  const fourthRow = { ...events[0], seq: 4, source_instance_id: 'source-b', source_event_id: 'other-event', source_seq: 2,
    source_payload_sha256: createHash('sha256').update(fourthCanonical).digest('hex'), payload_text: JSON.stringify({ prpEvent: fourth }) };
  const multipleSources = { ...fixture, run: { ...run, next_event_seq: 5, event_cursor_projection_seq: 4 },
    events: [...events, fourthRow],
    cursors: [cursor, { ...cursor, source_instance_id: 'source-b', contiguous_source_seq: 0 }],
    ranges: [range, { ...range, source_instance_id: 'source-b', start_seq: 2, end_seq: 2 }] };
  assert.equal(verifySnapshot(multipleSources).sources.length, 2);
  fails({ ...multipleSources, events: [...events, { ...fourthRow, source_event_id: events[0].source_event_id }] }, 'source_event_identity_conflict');
  fails({ ...multipleSources, events: [...events, { ...fourthRow, source_instance_id: 'source-a', source_seq: 1 }] }, 'source_sequence_identity_conflict');
  assert.equal(verifySnapshot({ ...fixture, run: { ...run, event_cursor_projection_seq: 0 }, cursors: [], ranges: [] }).projectionChecked, false);
  assert.throws(() => decodeStoredPayload({ [ORIGINAL_JSON_KEY]: 1 }), error => error.code === 'invalid_encoded_payload');
  assert.throws(() => decodeStoredPayload({ [ORIGINAL_JSON_KEY]: '[]' }), error => error.code === 'invalid_encoded_payload');
  return { selfTest: 'passed', databaseAccess: false, covered: ['NUL and reserved-key decoding', 'canonical ordering and array order',
    'multiple sparse sources', 'company binding', 'hash conflict', 'global and both source identity conflicts', 'projection conflicts', 'stale-marker skip'] };
}

async function main() {
  if (process.argv.includes('--self-test')) { console.log(JSON.stringify(selfTest(), null, 2)); return; }
  const options = name => process.argv.filter(value => value.startsWith('--' + name + '=')).map(value => value.slice(name.length + 3));
  const one = name => { const values = options(name); requireCondition(values.length === 1, 'supply_one_' + name); return values[0]; };
  const repository = one('repository'), companyId = one('company-id').toLowerCase(), runIds = options('run-id').map(value => value.toLowerCase());
  requireCondition(path.isAbsolute(repository), 'repository_must_be_absolute');
  requireCondition(UUID.test(companyId) && runIds.length > 0 && runIds.every(value => UUID.test(value))
    && new Set(runIds).size === runIds.length, 'supply_company_and_unique_run_uuids');
  let url;
  try { url = new URL(process.env[DATABASE_ENV]); } catch { throw new VerificationError('supply_' + DATABASE_ENV); }
  requireCondition(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.search && !url.hash,
  'database_must_be_explicit_loopback_without_query_overrides');
  requireCondition(url.pathname.length > 1, 'database_name_required');
  const require = createRequire(path.join(repository, 'packages/db/package.json'));
  const postgres = require('postgres');
  const sql = postgres({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: false, max: 1, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: 'paperclip_native_ingestion_independent_verify' } });
  let output;
  try {
    const proofs = await sql.begin('isolation level repeatable read read only', async tx => {
      const settings = await tx`select current_setting('transaction_read_only') as read_only,
        current_setting('transaction_isolation') as isolation`;
      requireCondition(settings[0]?.read_only === 'on' && settings[0]?.isolation === 'repeatable read', 'read_only_snapshot_required');
      const result = [];
      for (const runId of runIds) {
        const runs = await tx`select id, company_id, agent_id, status, next_event_seq, event_cursor_projection_seq,
          event_cursor_rebuild_pending from heartbeat_runs where company_id = ${companyId} and id = ${runId}`;
        requireCondition(runs.length === 1, 'bound_run_not_found');
        const events = await tx`select company_id, run_id, agent_id, seq, event_type, payload::text as payload_text,
          source_instance_id, source_event_id, source_seq, source_payload_sha256, protocol_schema_version
          from heartbeat_run_events where company_id = ${companyId} and run_id = ${runId} order by seq`;
        const run = runs[0], current = integer(run.event_cursor_projection_seq, 'invalid_projection_marker')
          === integer(run.next_event_seq, 'invalid_next_event_seq', 1) - 1;
        const cursors = current ? await tx`select company_id, run_id, source_instance_id, contiguous_source_seq,
          pending_range_count from heartbeat_run_event_cursors where company_id = ${companyId} and run_id = ${runId}` : [];
        const ranges = current ? await tx`select company_id, run_id, source_instance_id, start_seq, end_seq
          from heartbeat_run_event_source_ranges where company_id = ${companyId} and run_id = ${runId} order by source_instance_id, start_seq` : [];
        const proof = verifySnapshot({ companyId, run, events, cursors, ranges });
        if (process.argv.includes('--require-current-projection')) requireCondition(proof.projectionChecked, 'projection_is_stale');
        result.push(proof);
      }
      return result;
    });
    output = { verified: true, reconstructedVerifier: true, checkedAt: new Date().toISOString(),
      database: 'Supplied disposable loopback PostgreSQL; read-only repeatable-read snapshot',
      limitation: 'Cursor reconstruction requires the complete retained fixture history; no production or raw wire ACK durability claim', proofs };
  } finally { await sql.end({ timeout: 5 }); }
  const files = options('output');
  requireCondition(files.length <= 1, 'supply_at_most_one_output');
  if (files.length) await writeFile(files[0], JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // Driver errors can contain connection details. Only controlled codes leave this process.
    console.error(JSON.stringify({ verified: false, error: error instanceof VerificationError ? error.code : 'verifier_failed_details_suppressed' }));
    process.exitCode = 1;
  });
}
