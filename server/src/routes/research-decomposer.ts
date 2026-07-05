import { Router } from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { promises as fs, existsSync, mkdirSync, openSync } from "node:fs";
import * as path from "node:path";
import type { Db } from "@paperclipai/db";
import { assertAuthenticated } from "./authz.js";

// Research Decomposer board surface. Thin, isolated front-end over the terminal
// engine (decompose_paper.py): it spawns that engine against an isolated run dir
// and tails the EVENTS.jsonl it writes. It never touches the live decompose
// pipeline queue, the shared shadow ledger, or the candidates registry — the
// engine redirects those to the isolated run dir itself. `_db` is accepted for
// mount-signature parity; this surface does not use the database.

const ENGINE = "/root/cps/var/self_practice/paperclip-run-requests/decompose_paper.py";
const PYTHON = "/root/miniconda3/bin/python3";
const RUNS_DIR = "/root/cps/var/decompose_runs";
const UPLOADS = "/root/cps/var/decomposer_web/uploads";
const MAX_BYTES = 20 * 1024 * 1024;
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const ARTIFACTS = new Set([
  "DECOMPOSITION.json", "FEASIBILITY.json", "BACKTEST_SPEC.json",
  "metrics.json", "JUDGMENT.json", "SHADOW_SPEC.json", "LEARNING.md", "REPORT.md",
]);

const procs = new Map<string, () => boolean>(); // runId -> isAlive()
let counter = 0;

function slug(s: string, n = 40): string {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, n).replace(/^-+|-+$/g, "") || "paper";
}

function newRunId(hint: string): string {
  counter = (counter + 1) % 10000;
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "T");
  return `decompose-${ts}-${String(counter).padStart(4, "0")}-${slug(hint)}`;
}

function safeRunDir(runId: string): string {
  if (!RUN_ID_RE.test(runId ?? "")) return "";
  const d = path.resolve(RUNS_DIR, runId);
  if (d !== path.resolve(RUNS_DIR, path.basename(d)) || path.dirname(d) !== path.resolve(RUNS_DIR)) return "";
  return d;
}

function launch(runId: string, engineArgs: string[]): void {
  mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });
  const logFd = openSync(path.join(RUNS_DIR, runId, "engine.log"), "w");
  const child = spawn(PYTHON, [ENGINE, "--no-color", "--run-id", runId, ...engineArgs], {
    cwd: path.dirname(ENGINE),
    stdio: ["ignore", logFd, logFd],
  });
  let alive = true;
  child.on("exit", () => { alive = false; });
  child.on("error", () => { alive = false; });
  procs.set(runId, () => alive);
}

async function readEvents(dir: string, offset: number): Promise<{ events: unknown[]; done: boolean }> {
  const p = path.join(dir, "EVENTS.jsonl");
  const events: unknown[] = [];
  let done = false;
  if (existsSync(p)) {
    const text = await fs.readFile(p, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line); } catch { continue; }
      if (((ev.seq as number) ?? 0) > offset) events.push(ev);
      if (ev.step === "report" && ev.status === "done") done = true;
    }
  }
  return { events, done };
}

export function researchDecomposerRoutes(_db: Db) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

  router.post("/decompose/runs", upload.single("file"), async (req, res) => {
    assertAuthenticated(req);
    const text = String((req.body?.text ?? "")).trim();
    const url = String((req.body?.url ?? "")).trim();
    const file = req.file;
    const provided = [file ? 1 : 0, text ? 1 : 0, url ? 1 : 0].reduce((a, b) => a + b, 0);
    if (provided !== 1) {
      res.status(400).json({ error: "provide exactly one of: file, text, url" });
      return;
    }
    let runId: string;
    let args: string[];
    if (file) {
      if (!file.buffer?.length) { res.status(400).json({ error: "empty file" }); return; }
      runId = newRunId(path.parse(file.originalname || "paper").name);
      const ext = path.extname(file.originalname || "").toLowerCase();
      const suffix = [".pdf", ".txt", ".md"].includes(ext) ? ext : ".txt";
      mkdirSync(UPLOADS, { recursive: true });
      const saved = path.join(UPLOADS, `${runId}${suffix}`);
      await fs.writeFile(saved, file.buffer);
      args = [saved];
    } else if (url) {
      runId = newRunId(url);
      args = [url];
    } else {
      runId = newRunId(text.slice(0, 40));
      args = ["--text", text];
    }
    launch(runId, args);
    res.json({ runId });
  });

  router.get("/decompose/runs", async (req, res) => {
    assertAuthenticated(req);
    const runs: unknown[] = [];
    if (existsSync(RUNS_DIR)) {
      const names = (await fs.readdir(RUNS_DIR)).sort().reverse();
      for (const name of names) {
        const dir = path.join(RUNS_DIR, name);
        const evp = path.join(dir, "EVENTS.jsonl");
        if (!existsSync(evp)) continue;
        let title = name;
        let verdict: string | null = null;
        try {
          for (const line of (await fs.readFile(evp, "utf8")).split("\n")) {
            if (!line.trim()) continue;
            const e = JSON.parse(line);
            if (e.step === "ingest" && e.status === "ok") title = e.msg ?? name;
            if (e.step === "backtest" && e.data?.verdict) verdict = e.data.verdict;
          }
        } catch { /* skip malformed */ }
        const alive = procs.get(name);
        runs.push({
          runId: name, title, verdict,
          running: alive ? alive() : false,
          hasReport: existsSync(path.join(dir, "REPORT.md")),
        });
        if (runs.length >= 100) break;
      }
    }
    res.json({ runs });
  });

  router.get("/decompose/runs/:runId/events", async (req, res) => {
    assertAuthenticated(req);
    const dir = safeRunDir(req.params.runId);
    if (!dir) { res.status(400).json({ error: "invalid run id" }); return; }
    const offset = Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
    const { events, done } = await readEvents(dir, offset);
    const alive = procs.get(req.params.runId);
    res.json({ events, done, running: alive ? alive() : false });
  });

  router.get("/decompose/runs/:runId/report", async (req, res) => {
    assertAuthenticated(req);
    const dir = safeRunDir(req.params.runId);
    if (!dir) { res.status(400).json({ error: "invalid run id" }); return; }
    const rp = path.join(dir, "REPORT.md");
    if (!existsSync(rp)) { res.status(404).json({ error: "report not ready" }); return; }
    res.type("text/markdown").send(await fs.readFile(rp, "utf8"));
  });

  router.get("/decompose/runs/:runId/artifact/:name", async (req, res) => {
    assertAuthenticated(req);
    if (!ARTIFACTS.has(req.params.name)) { res.status(404).json({ error: "unknown artifact" }); return; }
    const dir = safeRunDir(req.params.runId);
    if (!dir) { res.status(400).json({ error: "invalid run id" }); return; }
    const p = path.join(dir, req.params.name);
    if (!existsSync(p)) { res.status(404).json({ error: "not found" }); return; }
    res.type(req.params.name.endsWith(".json") ? "application/json" : "text/markdown");
    res.send(await fs.readFile(p, "utf8"));
  });

  return router;
}
