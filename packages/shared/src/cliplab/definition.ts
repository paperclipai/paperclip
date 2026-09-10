import type { AgentAppearance, CharacterPaletteId, CharacterState } from "../agent-appearance.js";
import { defaultProject, definitionOf, sampleDefinition, BASE_POSE, type Definition, type Sample } from "./model.js";
import { CAP_V1_COLORS } from "./palette-tokens.js";

export function characterDefinition(appearance: AgentAppearance, muted = false): Definition {
  const project = defaultProject();
  const colors = CAP_V1_COLORS[(muted ? "muted-dream" : appearance.paletteId) as CharacterPaletteId];
  const character = { ...project.characters[1], id: "paperclip-cap-v1", name: "Agent", color: colors.a, color2: colors.b,
    gradientAngle: 0, iris: false, toon: true, shadow: false, followCursor: true, followRotation: true };
  const definition = definitionOf(project, character);
  for (const animation of definition.animations) if (animation.id === "happy") animation.loop = false;
  return definition;
}
export function animationId(state: CharacterState) { return state === "success" ? "happy" : state === "rest" ? "idle" : state; }
export function characterStill(definition: Definition, state: CharacterState): Sample {
  if (state === "rest") return { pose: { ...BASE_POSE }, blink: 0, bob: 0, breathe: 0, expressionId: "idle", beatIndex: 0, stepIndex: 0 };
  return sampleDefinition(definition, animationId(state), 0.6);
}
