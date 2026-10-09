import type { AgentAppearance, CharacterPaletteId, CharacterState } from "../agent-appearance.js";
import { definitionOf, sampleDefinition, type Definition, type Sample } from "./model.js";
import { CAP_V1_COLORS } from "./palette-tokens.js";
import { PAPERCLIP_CHARACTER } from "./character.js";

/**
 * One character, every palette: the studio export's body, expressions and
 * animations, recoloured with the agent's palette (or the presentation-only
 * gray). Body and eye following are on for live placements; static
 * portraits override them per render.
 */
export function characterDefinition(appearance: AgentAppearance, muted = false): Definition {
  const colors = CAP_V1_COLORS[(muted ? "muted-dream" : appearance.paletteId) as CharacterPaletteId];
  const character = { ...PAPERCLIP_CHARACTER.character, id: "paperclip-cap-v1", name: "Agent", color: colors.a, color2: colors.b, followCursor: true, followRotation: true };
  const definition = definitionOf({ version: 1, name: "Paperclip", characters: [character], expressions: PAPERCLIP_CHARACTER.expressions, animations: PAPERCLIP_CHARACTER.animations }, character);
  for (const animation of definition.animations) if (animation.id === "happy") animation.loop = false;
  return definition;
}
export function animationId(state: CharacterState) { return state === "success" ? "happy" : state === "rest" ? "idle" : state; }
/** A fixed sample per state for still portraits; rest is the idle expression's first beat, held. */
export function characterStill(definition: Definition, state: CharacterState): Sample {
  if (state === "rest") {
    const idle = definition.expressions.find((e) => e.id === "idle") ?? definition.expressions[0]!;
    return { pose: { ...idle.beats[0]!.pose }, blink: 0, bob: 0, breathe: 0, expressionId: idle.id, beatIndex: 0, stepIndex: 0, faceLayers: undefined };
  }
  return sampleDefinition(definition, animationId(state), 0.6);
}
