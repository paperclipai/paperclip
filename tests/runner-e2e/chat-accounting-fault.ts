import { randomBytes } from "node:crypto";
import { reviewedChatExecutionIds } from "./chat-runtime-profile.js";
import { ownedDatabaseUrl } from "./chat-archive-storage-fault.js";

/**
 * Test-only accounting fault for `budgets-costs.repair-cost-recording`.
 *
 * Saved usage is "Ready to record" only while recording a finished run's cost keeps failing; the
 * product settles every other run within seconds. A temporary trigger on the case-owned database
 * makes the product's own cost-event write for one seeded task fail, so the whole accounting
 * transaction rolls back and the run keeps its saved usage pending. Failures are counted in a
 * rollback-proof sequence. The trigger is dropped before the person retries; it never writes or
 * edits product rows, and all saved state comes from the product.
 */
export const ACCOUNTING_SCENARIO = "budgets-costs.repair-cost-recording";
export interface AccountingFaultBinding { companyId: string; issueId: string }
export interface AccountingFault {
  /** Cost-event writes the trigger refused, read from a rollback-proof sequence. */
  failures(): Promise<number>;
  release(): Promise<void>;
  close(): Promise<void>;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function validAccountingFaultBinding(value: AccountingFaultBinding) {
  return !!value && Object.keys(value).sort().join() === "companyId,issueId" && uuid.test(value.companyId) && uuid.test(value.issueId);
}

/** Statements only; ids are validated above and are the only interpolated values. */
export function accountingFaultSql(tag: string, binding: AccountingFaultBinding) {
  if (!/^[a-f0-9]{12}$/.test(tag) || !validAccountingFaultBinding(binding)) throw new Error("Accounting fault requires an exact owned binding");
  const name = `paperclip_e2e_accounting_fault_${tag}`, hits = `${name}_hits`;
  return {
    install: [
      `create sequence ${hits}`,
      `create function ${name}() returns trigger language plpgsql as $fault$
begin
  if NEW.company_id = '${binding.companyId}'::uuid and NEW.issue_id = '${binding.issueId}'::uuid then
    perform nextval('${hits}'::regclass);
    raise exception 'could not write cost event' using errcode = '58030';
  end if;
  return NEW;
end
$fault$`,
      `create trigger ${name} before insert on cost_events for each row execute function ${name}()`,
    ],
    release: [`drop trigger if exists ${name} on cost_events`],
    remove: [`drop trigger if exists ${name} on cost_events`, `drop function if exists ${name}()`, `drop sequence if exists ${hits}`],
    failures: `select case when is_called then last_value else 0 end as hits from ${hits}`,
  };
}

export async function armAccountingFault(input: { executionId: string; binding: AccountingFaultBinding; env?: NodeJS.ProcessEnv }): Promise<AccountingFault> {
  const env = input.env ?? process.env;
  let selected: unknown; try { selected = JSON.parse(env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "null"); } catch { selected = null; }
  if (!reviewedChatExecutionIds(ACCOUNTING_SCENARIO).includes(input.executionId) || !Array.isArray(selected) || selected.length !== 1 || selected[0] !== input.executionId)
    throw new Error("Accounting fault is allowed only when its own case is the single selected execution");
  const statements = accountingFaultSql(randomBytes(6).toString("hex"), input.binding);
  const { createDb } = await import("../../packages/db/src/index.js");
  const db = createDb(await ownedDatabaseUrl(env), { maxConnections: 1, connectTimeoutSeconds: 5 }), client = db.$client;
  let closed = false, released = false;
  const run = async (list: string[]) => { for (const statement of list) await client.unsafe(statement); };
  try { await client.begin(async tx => { for (const statement of statements.install) await tx.unsafe(statement); }); }
  catch (error) { await client.end({ timeout: 5 }); throw error; }
  return {
    async failures() {
      if (closed) throw new Error("Accounting fault is closed");
      const [row] = await client.unsafe(statements.failures); return Number(row?.hits ?? 0);
    },
    async release() { if (closed || released) throw new Error("Accounting fault was already released"); await run(statements.release); released = true; },
    async close() { if (closed) return; closed = true; try { await run(statements.remove); } finally { await client.end({ timeout: 5 }); } },
  };
}
