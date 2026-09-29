import { z } from "zod";

export const AGENT_PALETTE_IDS = ["bubblegum-sky", "pink-lemonade", "orchid-peach", "coral-mint", "lime-lagoon", "arctic-blue", "solar-flare", "violet-ember", "deep-tide", "coral-current", "golden-hour", "tangerine-cobalt", "electric-grove", "flamingo-jade", "cherry-pop", "turquoise-cherry", "ultraviolet-tide"] as const;
export type AgentPaletteId = typeof AGENT_PALETTE_IDS[number];
export type CharacterPaletteId = AgentPaletteId | "muted-dream";
export const AGENT_AVATAR_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512] as const;
export type AgentAvatarSize = typeof AGENT_AVATAR_SIZES[number];
export const CHARACTER_STATES = ["rest", "idle", "listening", "thinking", "working", "success", "confused", "sleepy", "loading"] as const;
export type CharacterState = typeof CHARACTER_STATES[number];
export const agentAppearanceSchema = z.object({
  schemaVersion: z.literal(1),
  characterVersion: z.literal("cap-v1"),
  paletteId: z.enum(AGENT_PALETTE_IDS),
}).strict();
export type AgentAppearance = z.infer<typeof agentAppearanceSchema>;

export function appearanceForPalette(paletteId: AgentPaletteId): AgentAppearance {
  return { schemaVersion: 1, characterVersion: "cap-v1", paletteId };
}
/** A persisted choice, never randomize while rendering. */
export function randomAgentAppearance(): AgentAppearance {
  const bytes = new Uint32Array(1);
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x100000000 / AGENT_PALETTE_IDS.length) * AGENT_PALETTE_IDS.length;
  do { globalThis.crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
  return appearanceForPalette(AGENT_PALETTE_IDS[bytes[0] % AGENT_PALETTE_IDS.length]);
}
/** Must match the migration: rolling base-31 hash, modulo 17 at every step. */
export function legacyAgentAppearance(id: string): AgentAppearance {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % AGENT_PALETTE_IDS.length;
  return appearanceForPalette(AGENT_PALETTE_IDS[hash]);
}
export function resolveAgentAppearance(appearance: unknown, id = "agent"): AgentAppearance {
  const parsed = agentAppearanceSchema.safeParse(appearance);
  return parsed.success ? parsed.data : legacyAgentAppearance(id);
}
export function agentAvatarUrl(appearance: AgentAppearance, size: AgentAvatarSize = 512, scale: 1 | 2 = 1, pose: CharacterState = "rest", muted = false): string {
  return `/api/agent-avatars/${appearance.characterVersion}/${muted ? "muted-dream" : appearance.paletteId}/${pose}.png?size=${size}&scale=${scale}`;
}
export function characterStateForAgent(status: string): CharacterState {
  if (status === "running") return "working";
  if (status === "error") return "confused";
  if (status === "paused" || status === "terminated" || status === "pending_approval") return "rest";
  return "idle";
}

/** Hydrate compact agent projections without an additional per-agent request. */
export function withAgentAppearance<T extends { id: string; appearance?: AgentAppearance | null }>(agent: T) {
  const appearance = resolveAgentAppearance(agent.appearance, agent.id);
  return { ...agent, appearance, avatarUrl: agentAvatarUrl(appearance) };
}
