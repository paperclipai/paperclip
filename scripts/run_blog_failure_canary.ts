import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDb } from "/Users/daehan/Documents/persona/paperclip/packages/db/src/index.ts";
import { blogRunService } from "/Users/daehan/Documents/persona/paperclip/server/src/services/blog-runs.ts";

const require = createRequire(import.meta.url);
const { Client } = require("/Users/daehan/Documents/persona/paperclip/node_modules/.pnpm/node_modules/pg") as typeof import("pg");

const DB_URL = process.env.PAPERCLIP_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "a900f7fe-3219-4afb-8fc2-6f55dedd5fe8";
const PROJECT_ID = process.env.ARTICLE_LOOP_PROJECT_ID || "c35ff304-0182-48e5-8bb3-375b191a371d";

async function main() {
  const db = createDb(DB_URL);
  const svc = blogRunService(db);
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  const topic = `Failure owner canary ${new Date().toISOString()}`;

  const created = await svc.create({
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    topic,
    lane: "publish",
    publishMode: "publish",
    contextJson: {
      topic,
      title: topic,
      verticalKey: "ai-tech",
      canary: true,
      canaryType: "failure_owner_routing",
    },
  });

  if (!created?.id) {
    throw new Error("canary_run_create_failed");
  }

  await pg.query(
    `update blog_runs
        set status = 'published',
            current_step = 'public_verify',
            updated_at = now()
      where id = $1`,
    [created.id],
  );

  const claimed = await svc.claimNextStep(created.id);
  if (!claimed?.attempt?.id) {
    throw new Error("canary_claim_failed");
  }

  await svc.failStep(created.id, "public_verify", {
    attemptId: claimed.attempt.id,
    errorCode: "BLOG_RUN_PUBLIC_VERIFY_FAILED",
    errorMessage: "blog_run_public_verify_failed:PUBLIC_VERIFY_REGRESSION",
  });

  const detail = await svc.getDetail(created.id);
  const stopReason = detail?.stopReason && typeof detail.stopReason === "object" ? detail.stopReason : null;

  console.log(JSON.stringify({
    ok: true,
    runId: created.id,
    topic,
    status: detail?.run.status ?? null,
    currentStep: detail?.run.currentStep ?? null,
    stopReason,
  }, null, 2));
  await pg.end();
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
