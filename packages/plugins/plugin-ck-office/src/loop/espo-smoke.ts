import type { PluginContext } from "@paperclipai/plugin-sdk";
import { Espo } from "../espo.js";

// One-shot Espo WRITE smoke test (manual trigger only — rare cron so it never fires on its own).
// Proves the deployed Paperclip worker can ACT on EspoCRM through the connector, not just read it:
// create a stream Note -> read it back -> edit it -> read again. Deletion is intentionally NOT done
// by the worker (agents don't delete — the no-delete rail); the single test artifact is cleaned up
// out-of-band by the operator. No outward send, local/tailnet only.
export const JOB_ESPO_SMOKE = "ck.espo-smoke";

export interface EspoSmokeResult {
  ok: boolean;
  createdId: string | null;
  readBackOk: boolean;
  updateOk: boolean;
  author: string | null;
  note: string;
}

export async function runEspoSmoke(espo: Espo, stamp: string): Promise<EspoSmokeResult> {
  const out: EspoSmokeResult = {
    ok: false, createdId: null, readBackOk: false, updateOk: false, author: null, note: "",
  };
  // 1) CREATE — a stream Post note, clearly labelled as a worker test artifact.
  const post0 = `[CK Paperclip worker — Espo write smoke ${stamp}] round-trip test; safe to delete`;
  const created = await espo.create<{ id: string; post?: string; createdByName?: string }>("Note", {
    type: "Post",
    post: post0,
  });
  out.createdId = created.id;
  out.author = created.createdByName ?? null;

  // 2) READ BACK — confirm it persisted and is the row we wrote.
  const fetched = await espo.get<{ id: string; post?: string }>("Note", created.id);
  out.readBackOk = fetched.id === created.id && (fetched.post ?? "").includes(stamp);

  // 3) UPDATE — edit the same record, then re-read to confirm the edit landed.
  const post1 = post0 + " — [edited by worker]";
  await espo.update("Note", created.id, { post: post1 });
  const refetched = await espo.get<{ post?: string }>("Note", created.id);
  out.updateOk = (refetched.post ?? "").includes("[edited by worker]");

  out.ok = !!out.createdId && out.readBackOk && out.updateOk;
  out.note = out.ok
    ? `Worker performed create+read+update on Espo Note ${out.createdId} as '${out.author}'. (Not deleted — operator cleans up.)`
    : `Espo write round-trip incomplete: created=${out.createdId} readBack=${out.readBackOk} update=${out.updateOk}`;
  return out;
}

export function registerEspoSmoke(
  ctx: PluginContext,
  deps: { getEspo: () => Promise<Espo | null> },
): void {
  ctx.jobs.register(JOB_ESPO_SMOKE, async (job) => {
    const espo = await deps.getEspo();
    if (!espo) {
      ctx.logger.warn("Espo smoke: no Espo config (set espoApiKey) — skipping.");
      return;
    }
    const stamp = new Date().toISOString();
    const r = await runEspoSmoke(espo, stamp);
    ctx.logger.info(
      `Espo smoke: ok=${r.ok} note=${r.createdId} readBack=${r.readBackOk} update=${r.updateOk} ` +
        `author=${r.author} (trigger=${job.trigger})`,
    );
    try {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === "CK IT Solutions");
      if (ck) {
        await ctx.activity.log({
          companyId: ck.id,
          message: `Espo write smoke test: ${r.note}`,
          entityType: "job",
          entityId: JOB_ESPO_SMOKE,
          metadata: { ...r },
        });
      }
    } catch (err) {
      ctx.logger.warn(`Espo smoke: activity log skipped (${String(err).slice(0, 80)})`);
    }
  });
}
