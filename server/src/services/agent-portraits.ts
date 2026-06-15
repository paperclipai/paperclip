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
const AGES = ["late 20s", "early 30s", "late 30s", "40s"];
// Seeded distinguishing features so two agents who land on the same gender/heritage/age still
// render as clearly different individuals (belt; the per-agent Imagen seed is the suspenders).
const HAIRSTYLES = [
  "a short cropped fade", "natural short curls", "shoulder-length locs", "a clean shaved head",
  "tight coils", "wavy swept-back hair", "a rounded afro", "braided hair",
];
const EXPRESSIONS = [
  "a faint confident smile", "a calm, focused expression", "a warm approachable smile",
  "a thoughtful, steady gaze",
];
const ACCESSORIES = [
  "wearing thin-framed glasses", "wearing small gold stud earrings", "with a subtle nose ring",
  "with no glasses or jewelry", "wearing bold-framed glasses",
];

// Gender → portrait noun. Explicit per-agent identity beats name-guessing; stored on the agent
// at runtime_config.persona.gender (set on hire / backfill). Falls back to a seeded presentation
// only when an agent has no gender recorded.
const GENDER_NOUN: Record<string, string> = {
  male: "man", man: "man", m: "man",
  female: "woman", woman: "woman", f: "woman",
  "non-binary": "person", nonbinary: "person", nb: "person", other: "person",
};

type PersonaConfig = { gender?: string; heritage?: string; age?: string };

function seedFrom(id: string, salt: number): number {
  return createHash("sha256").update(`${id}:${salt}`).digest().readUInt32BE(0);
}
function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

function readPersonaConfig(runtimeConfig: Record<string, unknown> | null | undefined): PersonaConfig {
  const persona = (runtimeConfig as { persona?: unknown } | null | undefined)?.persona;
  return persona && typeof persona === "object" ? (persona as PersonaConfig) : {};
}

function genderNoun(agentId: string, persona: PersonaConfig): string {
  const explicit = persona.gender?.trim().toLowerCase();
  if (explicit && GENDER_NOUN[explicit]) return GENDER_NOUN[explicit]!;
  // No gender recorded — keep deterministic so re-gen is stable, but vary across agents.
  return pick(["man", "woman", "person"], seedFrom(agentId, 2));
}

function buildPersona(agent: {
  id: string;
  name: string;
  role: string;
  runtimeConfig?: Record<string, unknown> | null;
}): string {
  const roleLabel = (AGENT_ROLE_LABELS as Record<string, string>)[agent.role] ?? agent.role;
  const persona = readPersonaConfig(agent.runtimeConfig);
  const gender = genderNoun(agent.id, persona);
  const heritage = persona.heritage ?? pick(HERITAGES, seedFrom(agent.id, 1));
  const age = persona.age ?? pick(AGES, seedFrom(agent.id, 3));
  const hair = pick(HAIRSTYLES, seedFrom(agent.id, 4));
  const expression = pick(EXPRESSIONS, seedFrom(agent.id, 5));
  const accessory = pick(ACCESSORIES, seedFrom(agent.id, 6));
  return (
    `A ${heritage} ${gender} in their ${age}, the company's ${roleLabel}, ` +
    `with ${hair}, ${expression}, ${accessory}, calm, sharp, and competent`
  );
}

// Deterministic per-agent image seed → distinct face per agent even when the persona text
// collides. Imagen rejects `seed` together with watermarking, so disable the watermark when
// seeding and fall back to an unseeded request if the model/key doesn't accept the param.
async function generatePortraitPng(prompt: string, seed?: number): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw unprocessable("GEMINI_API_KEY is not configured on this plane; portraits generate on the control plane (Vercel).");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${key}`;

  async function attempt(withSeed: boolean): Promise<Response> {
    const parameters: Record<string, unknown> = { sampleCount: 1, aspectRatio: "1:1" };
    if (withSeed && seed !== undefined) {
      parameters.seed = seed % 2_147_483_647;
      parameters.addWatermark = false;
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt }], parameters }),
    });
  }

  let resp = await attempt(seed !== undefined);
  if (!resp.ok && seed !== undefined) {
    // Seed/watermark combo not supported on this model — retry without it.
    resp = await attempt(false);
  }
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
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        name: agentsTable.name,
        role: agentsTable.role,
        runtimeConfig: agentsTable.runtimeConfig,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

    const png = await generatePortraitPng(`${buildPersona(agent)}. ${STYLE_SUFFIX}`, seedFrom(agent.id, 0));
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
