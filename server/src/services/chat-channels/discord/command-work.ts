import { takeCompanyWorkBatch } from "../../company-work-batch.js";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import type { CommandRegistrationDeadline, discordCommandSchedule } from "./command-schedule.js";
import type { CommandRegistrationScope } from "./command-work-notifications.js";

function decodeScope(hint: string): CommandRegistrationScope | undefined {
  if (hint === "*") return undefined;
  const separator = hint.indexOf(":");
  const kind = hint.slice(0, separator), id = hint.slice(separator + 1);
  if (kind !== "endpoint" && kind !== "connection" && kind !== "company")
    throw new Error("Unknown command registration scope");
  return { kind, id };
}

function matches(entry: CommandRegistrationDeadline, scope?: CommandRegistrationScope) {
  if (!scope) return true;
  return (scope.kind === "endpoint" ? entry.id : scope.kind === "connection" ? entry.connectionId : entry.companyId) === scope.id;
}

export function registerDiscordCommandWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof discordCommandSchedule>,
  canRun: () => boolean,
) {
  const dirty = new Set<string>(["*"]);
  const deadlines = new Map<string, CommandRegistrationDeadline>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const retryMs = 30_000;
  let earliest = 0;
  let lastCompany: string | null = null;
  function next() {
    let at: number | null = dirty.size ? earliest : null;
    for (const entry of deadlines.values()) {
      const due = Math.max(earliest, entry.dueAt, failures.get(entry.id)?.retryAt ?? 0);
      at = at === null ? due : Math.min(at, due);
    }
    return at;
  }
  return coordinator.register(DELIVERY_QUEUES.chatCommandRegistration, {
    retryMs,
    pausePassiveMaintenance: true,
    onSettled: hints => { for (const hint of hints ?? ["*"]) dirty.add(hint); },
    run: async signal => {
      if (!canRun() || Date.now() < earliest) return;
      earliest = Date.now() + retryMs;
      const requested = dirty.has("*") ? ["*"] : [...dirty];
      dirty.clear();
      const errors: unknown[] = [];
      const unavailable: Array<CommandRegistrationScope | undefined> = [];
      for (let index = 0; index < requested.length; index++) {
        if (signal.aborted || !canRun()) {
          for (const remaining of requested.slice(index)) dirty.add(remaining);
          return;
        }
        const hint = requested[index];
        let scope: CommandRegistrationScope | undefined;
        try {
          scope = decodeScope(hint);
          const rows = await service.load(scope, signal);
          for (const entry of deadlines.values()) if (matches(entry, scope)) deadlines.delete(entry.id);
          for (const entry of rows) deadlines.set(entry.id, entry);
          for (const id of failures.keys()) {
            const entry = deadlines.get(id);
            if (!entry || entry.dueAt > Date.now()) failures.delete(id);
          }
        } catch (error) { dirty.add(scope ? hint : "*"); unavailable.push(scope); errors.push(error); }
      }
      const due = [...deadlines.values()]
        .filter(entry => !unavailable.some(scope => matches(entry, scope)) &&
          Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
      const batch = takeCompanyWorkBatch(due, 25, lastCompany);
      lastCompany = batch.lastCompany;
      for (const entry of batch.entries) {
        if (signal.aborted || !canRun()) break;
        try {
          const current = await service.check(entry.id, signal);
          if (current) deadlines.set(entry.id, current); else deadlines.delete(entry.id);
          if (current && current.dueAt <= Date.now()) throw new Error("Discord command registration remains due");
          failures.delete(entry.id);
        } catch (error) {
          const count = Math.min((failures.get(entry.id)?.count ?? 0) + 1, 5);
          failures.set(entry.id, { count, retryAt: Date.now() + Math.min(300_000, retryMs * 2 ** (count - 1)) });
          errors.push(error);
        }
      }
      if (due.length > batch.entries.length) earliest = Date.now() + 1_000;
      if (errors.length) throw new AggregateError(errors, "Discord command registration could not settle");
    },
    // Preserve hints/deadlines for resume without holding settled intent during drain.
    // The coordinator independently fences unresolved database transactions.
    hasPending: async () => canRun() && dirty.size > 0,
    nextRunAt: next,
  });
}
