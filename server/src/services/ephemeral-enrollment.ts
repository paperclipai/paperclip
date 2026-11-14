import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { readBuildCommit } from "../build-commit.js";
import { loadConfig } from "../config.js";
import { conflict, unauthorized } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import type { CloudControlClaims } from "./cloud-runtime-identity.js";
import { cloudTenantPrimaryCompanyId, getCloudStackContext } from "./cloud-instance.js";
import { resolveDecisionSigningSecret } from "./decision-signing.js";
import { assertEphemeralServerConfig, ephemeralServerEnabled, readEphemeralServerDataEligibility } from "./ephemeral-server-contract.js";

export async function prepareOnlineEphemeralEnrollment(db: Db, attemptId: string, control: Pick<CloudControlClaims, "requestId" | "exp">) {
  const stackId = getCloudStackContext()?.stackId;
  const commit = readBuildCommit();
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
  if (!stackId || !commit || !deploymentId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deploymentId)) {
    throw conflict("Online enrollment requires a stamped managed Railway deployment");
  }
  const eligibility = await readEphemeralServerDataEligibility(db, { purpose: "startup" });
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
  if (control.exp * 1000 <= Date.now()) throw unauthorized("Cloud preparation assertion expired");
  const bytes = createHash("sha256").update(`paperclip-ephemeral-preparation:v1:${stackId}:${control.requestId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  try {
    const { publication } = await persistActivity(db, { companyId: cloudTenantPrimaryCompanyId(stackId), actorType: "system", actorId: "paperclip-cloud",
      action: "instance.ephemeral_enrollment.prepared", entityType: "instance", entityId: stackId, details: receipt }, { id });
    publishActivity(publication);
  } catch (error) {
    const pg = (error as { cause?: { code?: string; constraint_name?: string } }).cause ?? error as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === "activity_log_pkey") throw conflict("Cloud preparation assertion was already used");
    throw error;
  }
  if (control.exp * 1000 <= Date.now()) throw unauthorized("Cloud preparation assertion expired");
  return { ...receipt, decisionSigningSecret };
}
