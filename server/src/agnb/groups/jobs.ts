import type { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertInstanceAdmin } from "../../routes/authz.js";
import { getAgnbScheduler } from "../scheduler.js";

/**
 * AGNB job management — list job status, manually trigger, toggle enabled.
 * Instance-admin only (operational controls). See scheduler.ts.
 */
export function registerJobs(router: Router, _db: Db) {
  /** GET /api/agnb/jobs — list jobs + last-run status. */
  router.get("/agnb/jobs", (req, res) => {
    assertInstanceAdmin(req);
    const sched = getAgnbScheduler();
    res.json({ ok: true, enabled: !!sched, jobs: sched?.list() ?? [] });
  });

  /** POST /api/agnb/jobs/:key/run — trigger a job now. */
  router.post("/agnb/jobs/:key/run", async (req, res) => {
    assertInstanceAdmin(req);
    const sched = getAgnbScheduler();
    if (!sched) {
      res.status(503).json({ ok: false, error: "scheduler not running" });
      return;
    }
    const st = await sched.runNow(req.params.key as string);
    res.json({ ok: true, result: st.lastResult, lastDurationMs: st.lastDurationMs });
  });

  /** POST /api/agnb/jobs/:key/toggle?enabled=true|false */
  router.post("/agnb/jobs/:key/toggle", (req, res) => {
    assertInstanceAdmin(req);
    const sched = getAgnbScheduler();
    if (!sched) {
      res.status(503).json({ ok: false, error: "scheduler not running" });
      return;
    }
    const enabled = String(req.query.enabled) === "true";
    const st = sched.setEnabled(req.params.key as string, enabled);
    if (!st) {
      res.status(404).json({ ok: false, error: "unknown job" });
      return;
    }
    res.json({ ok: true, key: req.params.key, enabled });
  });
}
