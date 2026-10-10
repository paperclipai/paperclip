import { and, eq } from "drizzle-orm";
import { computers, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  ComputerError,
  type ComputerRecord,
  type Ledger,
} from "../domain/ledger.js";
import type { ComputerRepository } from "../application/ports.js";
export function computerRepository(db: Db): ComputerRepository {
  const decode = (row: typeof computers.$inferSelect): ComputerRecord => ({
    ...row,
    ledger: row.ledger as unknown as Ledger,
  });
  const where = (scope: { companyId: string; environmentId: string }) =>
    and(
      eq(computers.companyId, scope.companyId),
      eq(computers.environmentId, scope.environmentId),
    );
  return {
    async create(record) {
      await db.transaction(async (tx) => {
        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, record.companyId))
          .for("update");
        if (!company) throw new ComputerError("not_found", "Company not found");
        await tx
          .insert(computers)
          .values({
            ...record,
            ledger: record.ledger as unknown as Record<string, unknown>,
          });
      });
    },
    async get(scope) {
      const [row] = await db.select().from(computers).where(where(scope));
      if (!row)
        throw new ComputerError(
          "not_found",
          "Computer is not attached to this company",
        );
      return decode(row);
    },
    async update(scope, fn) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(computers)
          .where(where(scope))
          .for("update");
        if (!row)
          throw new ComputerError(
            "not_found",
            "Computer is not attached to this company",
          );
        const record = decode(row);
        const result = fn(record);
        await tx
          .update(computers)
          .set({
            ledger: record.ledger as unknown as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(computers.id, row.id));
        return result;
      });
    },
    async runState(scope, runId, agentId) {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, scope.companyId),
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.agentId, agentId),
          ),
        );
      if (!run) return "missing";
      return [
        "succeeded",
        "interrupted",
        "failed",
        "cancelled",
        "timed_out",
      ].includes(run.status)
        ? "terminal"
        : "active";
    },
    async all() {
      return (await db.select().from(computers)).map(decode);
    },
  };
}
