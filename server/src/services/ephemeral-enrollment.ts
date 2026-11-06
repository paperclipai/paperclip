import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { readBuildCommit } from "../build-commit.js";
import { loadConfig } from "../config.js";
import { conflict } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { cloudTenantPrimaryCompanyId, getCloudStackContext } from "./cloud-instance.js";
import { resolveDecisionSigningSecret } from "./decision-signing.js";
import { assertEphemeralServerConfig, ephemeralServerEnabled, readEphemeralServerDataEligibility } from "./ephemeral-server-contract.js";

export async function prepareOnlineEphemeralEnrollment(db: Db, attemptId: string) {
  const stackId = getCloudStackContext()?.stackId;
  const commit = readBuildCommit();
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
  if (!stackId || !commit || !deploymentId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deploymentId)) {
    throw conflict("Online enrollment requires a stamped managed Railway deployment");
  }
  const eligibility = await readEphemeralServerDataEligibility(db);
  if (!eligibility.eligible) throw conflict("Durable data migration is incomplete", { blockers: eligibility.blockers });
  const decisionSigningSecret = resolveDecisionSigningSecret({ allowCreate: false });
  assertEphemeralServerConfig(loadConfig(), { ...process.env, PAPERCLIP_EPHEMERAL_SERVER: "true",
    PAPERCLIP_DECISION_SIGNING_SECRET: decisionSigningSecret });
  const receipt = {
    schema: "paperclip.online-ephemeral-enrollment.v1" as const,
    attemptId, stackId, commit, deploymentId, observedAt: new Date().toISOString(),
    ephemeralServer: ephemeralServerEnabled(),
    decisionKeyDigest: createHash("sha256").update(decisionSigningSecret).digest("hex"),
    enrollmentReady: false as const,
  };
  await logActivity(db, { companyId: cloudTenantPrimaryCompanyId(stackId), actorType: "system", actorId: "paperclip-cloud",
    action: "instance.ephemeral_enrollment.prepared", entityType: "instance", entityId: stackId, details: receipt });
  return { ...receipt, decisionSigningSecret };
}
