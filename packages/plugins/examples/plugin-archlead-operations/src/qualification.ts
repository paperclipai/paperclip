import type {
  PluginContext,
  PluginEntityRecord,
} from "@paperclipai/plugin-sdk";
import {
  canonicalJson,
  ENTITY_TYPES,
  parseSandboxQualificationInput,
  payloadSha256,
  PluginRequestError,
  stringField,
  type SandboxQualificationInput,
} from "./contracts.js";
import {
  findEntity,
  logMutation,
  upsertEntity,
  upsertIdempotentEntity,
} from "./crm.js";
import { PLUGIN_ID } from "./manifest.js";

export const QUALIFICATION_ORIGIN = `plugin:${PLUGIN_ID}:sandbox-qualification`;
const qualificationLocks = new Map<string, Promise<void>>();

export async function withQualificationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = qualificationLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  qualificationLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (qualificationLocks.get(key) === tail) qualificationLocks.delete(key);
  }
}

export function qualificationDescription(input: SandboxQualificationInput): string {
  const field = (value: string | null, fallback: string) =>
    (value ? value.replace(/[\r\n\t]+/g, " ").trim() : fallback).slice(0, 2_000);
  return [
    "Sandbox-only synthetic lead qualification task. No email, payment, or external provider action is enabled.",
    `externalLeadId: ${input.externalLeadId}`,
    "qualificationStatus: pending_review",
    "approvalStatus: required",
    "outreachStatus: blocked",
    "",
    `Synthetic lead: ${field(input.lead.name, "Not provided")}`,
    `Email: ${field(input.lead.email, "Not provided")}`,
    `Business: ${field(input.lead.business, "Not provided")}`,
    `Source: ${field(input.lead.source, "Not provided")}`,
    `Summary: ${field(input.lead.message, "Not provided")}`,
  ].join("\n");
}

export function qualificationLifecycle(interactionStatus: string | null | undefined): {
  qualificationStatus: "pending_review" | "qualified" | "disqualified";
  approvalStatus: "required" | "approved" | "rejected";
  outreachStatus: "blocked";
} {
  if (interactionStatus === "accepted") {
    return { qualificationStatus: "qualified", approvalStatus: "approved", outreachStatus: "blocked" };
  }
  if (interactionStatus === "rejected") {
    return { qualificationStatus: "disqualified", approvalStatus: "rejected", outreachStatus: "blocked" };
  }
  return { qualificationStatus: "pending_review", approvalStatus: "required", outreachStatus: "blocked" };
}

export async function qualificationTaskStatus(
  ctx: PluginContext,
  companyId: string,
  record: PluginEntityRecord,
) {
  const externalLeadId = stringField(record.externalId, 200);
  if (!externalLeadId) throw new Error("Stored sandbox qualification task is missing its external lead ID");
  const issueId = stringField(record.data.issueId, 100);
  const interactionId = stringField(record.data.interactionId, 100);
  const [issue, interactions] = issueId
    ? await Promise.all([
      ctx.issues.get(issueId, companyId),
      ctx.issues.listInteractions(issueId, companyId),
    ])
    : [null, []];
  const interaction = interactionId ? interactions.find((item) => item.id === interactionId) : null;
  return {
    externalLeadId,
    issueId,
    interactionId,
    issueTitle: issue?.title ?? null,
    issueStatus: issue?.status ?? null,
    interactionStatus: interaction?.status ?? null,
    synthetic: record.data.synthetic === true,
    ...qualificationLifecycle(interaction?.status),
  };
}

export async function createSandboxQualificationTask(
  ctx: PluginContext,
  companyId: string,
  body: unknown,
): Promise<{
  created: boolean;
  issueId: string;
  interactionId: string;
  qualificationStatus: "pending_review" | "qualified" | "disqualified";
  approvalStatus: "required" | "approved" | "rejected";
  outreachStatus: "blocked";
  synthetic: true;
}> {
  const input = parseSandboxQualificationInput(body);
  if (!input) {
    throw new PluginRequestError(
      422,
      "Sandbox qualification requires sandbox:true, a sandbox: externalLeadId, and an @example.test email",
    );
  }
  const key = `${companyId}:${input.externalLeadId}`;
  return withQualificationLock(key, async () => {
    const digest = payloadSha256(canonicalJson(input));
    const existing = await findEntity(ctx, companyId, ENTITY_TYPES.qualificationTask, input.externalLeadId);
    if (existing && existing.data.sourcePayloadSha256 !== digest) {
      throw new PluginRequestError(409, "This synthetic lead ID was already used with different lead data");
    }

    const stored = await upsertIdempotentEntity(ctx, {
      companyId,
      entityType: ENTITY_TYPES.qualificationTask,
      externalId: input.externalLeadId,
      title: `[SANDBOX] Review lead: ${input.lead.name.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`,
      status: "pending_review",
      data: {
        externalLeadId: input.externalLeadId,
        ...input.lead,
        synthetic: true,
        qualificationStatus: "pending_review",
        approvalStatus: "required",
        outreachStatus: "blocked",
        sourcePayloadSha256: digest,
      },
    });

    const originId = input.externalLeadId;
    const existingIssues = await ctx.issues.list({
      companyId,
      originKind: QUALIFICATION_ORIGIN,
      originId,
      limit: 1,
    });
    let foundIssue: any = existingIssues[0] ?? null;
    if (!foundIssue && existing?.data?.issueId && typeof existing.data.issueId === "string") {
      foundIssue = await ctx.issues.get(existing.data.issueId, companyId).catch(() => null);
    }
    const issue = foundIssue ?? await ctx.issues.create({
      companyId,
      title: `[SANDBOX] Review lead: ${input.lead.name.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`,
      description: qualificationDescription(input),
      status: "todo",
      priority: "medium",
      originKind: QUALIFICATION_ORIGIN,
      originId,
    });

    const idempotencyKey = `${PLUGIN_ID}:qualification:${digest}`;
    const interactions = await ctx.issues.listInteractions(issue.id, companyId);
    let existingInteraction = interactions.find((interaction) => interaction.idempotencyKey === idempotencyKey) ?? null;
    if (!existingInteraction && existing?.data?.interactionId && typeof existing.data.interactionId === "string") {
      existingInteraction = interactions.find((item) => item.id === existing.data.interactionId) ?? null;
    }
    const interaction = existingInteraction ?? await ctx.issues.requestConfirmation(
      issue.id,
      {
        idempotencyKey,
        continuationPolicy: "none",
        title: "Sandbox lead qualification approval",
        summary: "Approve qualification only; external outreach remains blocked.",
        payload: {
          version: 1,
          prompt: "Does this synthetic lead qualify for the sandbox simulation?",
          acceptLabel: "Qualify synthetic lead",
          rejectLabel: "Disqualify synthetic lead",
          rejectRequiresReason: false,
          allowDeclineReason: false,
          detailsMarkdown: [
            `**Synthetic lead:** ${input.lead.name.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`,
            `**Email:** ${input.lead.email.replace(/[\r\n\t]+/g, " ").slice(0, 320)}`,
            `**Business:** ${(input.lead.business || "Not provided").replace(/[\r\n\t]+/g, " ").slice(0, 240)}`,
            "",
            "This decision does not send email, initiate payment, or contact a provider.",
          ].join("\n"),
        },
      },
      companyId,
    );
    const lifecycle = qualificationLifecycle(interaction.status);

    await upsertEntity(ctx, companyId, ENTITY_TYPES.qualificationTask, input.externalLeadId, issue.title, lifecycle.qualificationStatus, {
      externalLeadId: input.externalLeadId,
      ...input.lead,
      synthetic: true,
      issueId: issue.id,
      interactionId: interaction.id,
      ...lifecycle,
      sourcePayloadSha256: digest,
    });
    if (!existing && stored.created) {
      await logMutation(ctx, companyId, ENTITY_TYPES.qualificationTask, input.externalLeadId, "Created a synthetic lead qualification task", {
        issueId: issue.id,
        interactionId: interaction.id,
      });
    }
    return {
      created: !existing,
      issueId: issue.id,
      interactionId: interaction.id,
      ...lifecycle,
      synthetic: true,
    };
  });
}
