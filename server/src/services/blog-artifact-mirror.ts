import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultBlogRunsDir } from "../home-paths.js";

const STEP_FILE_MAP: Record<string, string> = {
  research: "research.json",
  draft: "draft.json",
  image: "image.json",
  draft_review: "draft.review.json",
  draft_polish: "draft.polish.json",
  final_review: "draft.final-review.json",
  validate: "validation.json",
  publish: "publish.json",
  public_verify: "verify.json",
};

type MirrorStatusInput = {
  phase: string | null;
  state: "queued" | "running" | "failed" | "completed" | "review_required" | "resumable";
  lastCompletedStep: string | null;
  nextStep: string | null;
  error: string | null;
  stopReason?: Record<string, unknown> | null;
};

type MirrorContextRun = {
  id: string;
  topic: string;
  lane: string;
  targetSite: string;
  publishMode: string;
  wordpressPostId?: number | null;
  createdAt?: Date | null;
  contextJson?: Record<string, unknown> | null;
};

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function blogArtifactMirrorService(input?: { baseDir?: string }) {
  const baseDir = path.resolve(input?.baseDir ?? resolveDefaultBlogRunsDir());

  function resolveRunDir(runId: string) {
    return path.resolve(baseDir, runId);
  }

  async function writeContext(run: MirrorContextRun) {
    const context = {
      run_id: run.id,
      created_at: run.createdAt instanceof Date ? run.createdAt.toISOString() : new Date().toISOString(),
      topic: run.topic,
      lane: run.lane,
      target_site: run.targetSite,
      wordpress: {
        publish: run.publishMode === "publish",
        status: run.publishMode === "publish" ? "publish" : "draft",
        post_id: run.wordpressPostId ?? null,
      },
      ...toRecord(run.contextJson),
    };
    await writeJson(path.join(resolveRunDir(run.id), "context.json"), context);
    return context;
  }

  async function writeStatus(runId: string, status: MirrorStatusInput) {
    const payload = {
      phase: status.phase,
      state: status.state,
      last_completed_step: status.lastCompletedStep,
      next_step: status.nextStep,
      error: status.error,
      stop_reason: status.stopReason ?? null,
      updated_at: new Date().toISOString(),
    };
    await writeJson(path.join(resolveRunDir(runId), "status.json"), payload);
    return payload;
  }

  async function writeStopReason(runId: string, stopReason: Record<string, unknown>) {
    const filePath = path.join(resolveRunDir(runId), "stop-reason.json");
    await writeJson(filePath, stopReason);
    return filePath;
  }

  async function readStopReason(runId: string) {
    try {
      const raw = await fs.readFile(path.join(resolveRunDir(runId), "stop-reason.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function writeResumeReview(runId: string, payload: Record<string, unknown>) {
    const filePath = path.join(resolveRunDir(runId), "resume-review.json");
    await writeJson(filePath, payload);
    return filePath;
  }

  async function writeResumeEvidence(runId: string, payload: Record<string, unknown>) {
    const filePath = path.join(resolveRunDir(runId), "resume-evidence.json");
    await writeJson(filePath, payload);
    return filePath;
  }

  async function writeStepResult(runId: string, stepKey: string, result: unknown) {
    const fileName = STEP_FILE_MAP[stepKey];
    if (!fileName) return null;
    const runDir = resolveRunDir(runId);
    const record = result ?? {};
    await writeJson(path.join(runDir, fileName), record);
    if (stepKey === "draft") {
      const articleHtml = String(toRecord(record).article_html ?? "").trim();
      if (articleHtml) {
        await fs.writeFile(path.join(runDir, "draft.md"), `${articleHtml}\n`, "utf8");
      }
    }
    return path.join(runDir, fileName);
  }

  async function writeStepArtifacts(runId: string, stepKey: string, artifacts: unknown[]) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
    const fileName = `artifacts.${stepKey}.json`;
    await writeJson(path.join(resolveRunDir(runId), fileName), artifacts);
    return path.join(resolveRunDir(runId), fileName);
  }

  async function createScratchRoot() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-blog-mirror-"));
    return dir;
  }

  return {
    baseDir,
    resolveRunDir,
    writeContext,
    writeStatus,
    writeStopReason,
    readStopReason,
    writeResumeReview,
    writeResumeEvidence,
    writeStepResult,
    writeStepArtifacts,
    createScratchRoot,
  };
}
