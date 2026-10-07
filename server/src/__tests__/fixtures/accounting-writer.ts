// Dedicated real-process fault fixture. Only invoked with a throwaway test DB.
import { createDb } from "@paperclipai/db";
import { costService } from "../../services/costs.js";
import { createRunUsageRecorder } from "../../services/usage-receipts.js";
const [mode, encoded] = process.argv.slice(2);
const input = JSON.parse(encoded);
if (!process.env.PAPERCLIP_ACCOUNTING_TEST_DATABASE) throw new Error("Explicit test database required");
const db = createDb(process.env.PAPERCLIP_ACCOUNTING_TEST_DATABASE);
try {
  if (mode === "receipt") {
    const recorder = await createRunUsageRecorder(db, { companyId: input.companyId, runId: input.runId, adapterType: "process" }, input.directory);
    // The receipt is fsynced before persistUsageReceipt enters a transaction.
    // Freeze at this boundary, so the parent can SIGKILL us before any DB row.
    db.transaction = async () => { process.stdout.write("RECEIPT_DURABLE\n"); return new Promise(() => {}); };
    await recorder.capture({ costUsdExact: "0.012345678", usage: { inputTokens: 7, cachedInputTokens: 11, outputTokens: 3 }, complete: true, billingType: "metered_api" });
  } else {
    await Promise.all(Array.from({ length: 4 }, () => costService(db).createEvent(input.companyId, { ...input.receipt, occurredAt: new Date(input.receipt.occurredAt) })));
    process.stdout.write("WRITES_COMMITTED\n");
  }
} finally { await db.$client.end(); }
