import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  assets,
  companies,
  createDb,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  extractImageSourceIds,
  hasReferenceBackedImageGenerationEvidence,
  resolveIssueImageReferenceGuardrail,
  textRequiresActualImageReference,
} from "../services/image-reference-guardrails.js";

describe("image reference guardrails", () => {
  it("detects the SIX-3832 board requirement as a hard visual-input request", () => {
    expect(textRequiresActualImageReference(
      "Fix this photo using the attachment I provided. Include the attachment photo as reference to GPT Image, not only extracting it as a prompt and remaking it with pure text to image.",
    )).toBe(true);
  });

  it("does not gate ordinary screenshot review or prompt-only image creation", () => {
    expect(textRequiresActualImageReference("Please check the attached screenshot and report the bug.")).toBe(false);
    expect(textRequiresActualImageReference("Generate a new abstract background from this text prompt.")).toBe(false);
  });

  it("extracts attachment and inline asset references in stable order", () => {
    expect(extractImageSourceIds([
      "![](/api/assets/a263ba8d-08ff-4c9b-97c3-e21b06e40278/content)",
      "[portrait](/api/attachments/1bfafac8-e11e-489f-9342-2a010d5f8a70/content)",
      "https://paper.example/api/assets/93844169-a4f8-46c2-99cf-508dda689384/content",
      "![](/api/assets/a263ba8d-08ff-4c9b-97c3-e21b06e40278/content)",
    ].join("\n"))).toEqual({
      attachmentIds: ["1bfafac8-e11e-489f-9342-2a010d5f8a70"],
      assetIds: [
        "a263ba8d-08ff-4c9b-97c3-e21b06e40278",
        "93844169-a4f8-46c2-99cf-508dda689384",
      ],
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("image reference guardrail persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-image-reference-guardrail-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("carries board intent and image candidates into a child lane and recognizes audited evidence", async () => {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const inlineAssetId = randomUUID();
    const childAssetId = randomUUID();
    const childAttachmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "SixZenith",
      issuePrefix: "SIX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Fix photo",
        description: `Use my portrait as an actual GPT Image reference, not a prompt-only recreation. ![](/api/assets/${inlineAssetId}/content)`,
        status: "in_progress",
        priority: "medium",
        createdByUserId: "board-user",
      },
      {
        id: childId,
        companyId,
        parentId,
        title: "Correct portrait likeness",
        description: "Regenerate the post with the supplied portrait.",
        status: "in_progress",
        priority: "medium",
      },
    ]);
    await db.insert(assets).values([
      {
        id: inlineAssetId,
        companyId,
        provider: "local_disk",
        objectKey: `${companyId}/assets/portrait.jpg`,
        contentType: "image/jpeg",
        byteSize: 100,
        sha256: "inline-sha",
        originalFilename: "portrait.jpg",
      },
      {
        id: childAssetId,
        companyId,
        provider: "local_disk",
        objectKey: `${companyId}/issues/child/portrait-copy.jpg`,
        contentType: "image/jpeg",
        byteSize: 100,
        sha256: "child-sha",
        originalFilename: "portrait-copy.jpg",
        createdByUserId: "board-user",
      },
    ]);
    await db.insert(issueAttachments).values({
      id: childAttachmentId,
      companyId,
      issueId: childId,
      assetId: childAssetId,
    });

    const guardrail = await resolveIssueImageReferenceGuardrail(db, { issueId: childId, companyId });
    expect(guardrail.required).toBe(true);
    expect(guardrail.issueScopeIds).toEqual([childId, parentId]);
    expect(guardrail.candidateAssetIds).toEqual([inlineAssetId]);
    expect(guardrail.candidateAttachmentIds).toContain(childAttachmentId);
    await expect(hasReferenceBackedImageGenerationEvidence(db, { issueId: childId, companyId })).resolves.toBe(false);

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: "designer-agent",
      action: "issue.image_generation_created",
      entityType: "issue",
      entityId: childId,
      details: {
        generationMode: "reference_backed",
        actualImageInputsBound: [childAttachmentId],
      },
    });

    await expect(hasReferenceBackedImageGenerationEvidence(db, { issueId: childId, companyId })).resolves.toBe(true);
    await expect(hasReferenceBackedImageGenerationEvidence(db, { issueId: parentId, companyId })).resolves.toBe(true);
  });
});
