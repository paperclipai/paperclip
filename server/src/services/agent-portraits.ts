import { createHash } from "node:crypto";
import { eq, isNull, and } from "drizzle-orm";
import { type Db, agents as agentsTable } from "@valadrien-os/db";
import { AGENT_ROLE_LABELS } from "@valadrien-os/shared";
import type { StorageService } from "../storage/types.js";
import { assetService } from "./assets.js";
import { notFound, unprocessable } from "../errors.js";

// Imagen 4.0 Fast via the Gemini API (see docs/portrait-generation.md). Override via env if a
// key only has access to gemini-3.1-flash-image, etc.
const IMAGEN_MODEL = process.env.AGENT_PORTRAIT_MODEL ?? "imagen-4.0-fast-generate-001";

const STYLE_SUFFIX =
  "3D rendered stylized-realistic character portrait, Pixar / Unreal-engine render quality, " +
  "soft subsurface-scattering skin, head and shoulders, facing camera, soft cinematic studio " +
  "lighting with a subtle cool rim light, plain dark charcoal background, centered square " +
  "composition, professional, dignified, no text, no logo, no watermark.";

// Diversity default per the spec (POC, Caribbean + Latin American). Seeded by agent id so each
// agent gets a distinct-but-deterministic identity — re-generating yields the same look.
const HERITAGES = [
  "Afro-Caribbean", "Haitian", "Dominican", "Afro-Latino", "Caribbean",
  "Latin American", "Puerto Rican", "Jamaican", "Cuban",
];
const PRESENTATIONS = ["masculine-presenting", "feminine-presenting", "androgynous"];
const AGES = ["late 20s", "early 30s", "late 30s", "40s"];

function seedFrom(id: string, salt: number): number {
  return createHash("sha256").update(`${id}:${salt}`).digest().readUInt32BE(0);
}
function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

function buildPersona(agent: { id: string; name: string; role: string }): string {
  const roleLabel = (AGENT_ROLE_LABELS as Record<string, string>)[agent.role] ?? agent.role;
  const heritage = pick(HERITAGES, seedFrom(agent.id, 1));
  const presentation = pick(PRESENTATIONS, seedFrom(agent.id, 2));
  const age = pick(AGES, seedFrom(agent.id, 3));
  return `A ${age} ${heritage} ${presentation} person, the company's ${roleLabel}, calm, sharp, and competent`;
}

async function generatePortraitPng(prompt: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw unprocessable("GEMINI_API_KEY is not configured on this plane; portraits generate on the control plane (Vercel).");
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "1:1" },
      }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw unprocessable(`Imagen request failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { predictions?: Array<{ bytesBase64Encoded?: string }> };
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw unprocessable("Imagen returned no image");
  return Buffer.from(b64, "base64");
}

export function agentPortraitService(db: Db, storage: StorageService) {
  const assets = assetService(db);

  async function generateForAgent(
    companyId: string,
    agentId: string,
    actor: { agentId: string | null; userId: string | null },
  ): Promise<{ portraitUrl: string }> {
    const agent = await db
      .select({ id: agentsTable.id, companyId: agentsTable.companyId, name: agentsTable.name, role: agentsTable.role })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

    const png = await generatePortraitPng(`${buildPersona(agent)}. ${STYLE_SUFFIX}`);
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/agent-portraits",
      originalFilename: `${agent.name}-portrait.png`,
      contentType: "image/png",
      body: png,
    });
    const asset = await assets.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.userId,
    });
    const portraitUrl = `/api/assets/${asset.id}/content`;
    await db.update(agentsTable).set({ portraitUrl, updatedAt: new Date() }).where(eq(agentsTable.id, agentId));
    return { portraitUrl };
  }

  // Generate for every agent in the company that has no portrait yet. Per-agent failures are
  // collected, not fatal, so one bad generation doesn't abort the backfill.
  async function backfillCompany(
    companyId: string,
    actor: { agentId: string | null; userId: string | null },
  ): Promise<{ generated: string[]; failed: Array<{ agentId: string; error: string }> }> {
    const missing = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.companyId, companyId), isNull(agentsTable.portraitUrl)));
    const generated: string[] = [];
    const failed: Array<{ agentId: string; error: string }> = [];
    for (const { id } of missing) {
      try {
        await generateForAgent(companyId, id, actor);
        generated.push(id);
      } catch (err) {
        failed.push({ agentId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { generated, failed };
  }

  return { generateForAgent, backfillCompany };
}
