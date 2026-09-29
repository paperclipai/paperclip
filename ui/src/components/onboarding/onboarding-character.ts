import type { AgentAppearance, CharacterPaletteId } from "@paperclipai/shared";
import { CAP_V1_COLORS } from "@paperclipai/shared/cliplab/palette-tokens";
import type { Definition } from "@paperclipai/shared/cliplab/model";

/**
 * The onboarding hero's ClipLab definition: the studio's App export
 * (`ui/src/assets/cliplab/onboarding.character.json`, mirrored into the
 * shared package as PAPERCLIP_CHARACTER) played by the shared engine. Three sequences carry the arc; they are found by role rather
 * than by hard-coded id so a re-export from the studio only has to keep the
 * shape below, not the names.
 *
 * - asleep: the loop shown while the agent is being specified.
 * - wake:   the one-shot sleepy → wink → idle transition, played once on Review.
 *           The runtime holds its final pose when it ends.
 * - awake:  the idle loop (breath and blink) the hero settles into afterwards.
 */
export interface OnboardingSequences { asleep: string; wake: string; awake: string }

const ASLEEP_ID = "sleepy";
const AWAKE_ID = "idle";

export function resolveOnboardingSequences(definition: Pick<Definition, "animations">): OnboardingSequences {
  const ids = definition.animations.map((a) => a.id);
  // The transition is the export's one-shot; the loops keep their studio ids.
  const wake = definition.animations.find((a) => !a.loop)?.id;
  const asleep = ids.includes(ASLEEP_ID) ? ASLEEP_ID : undefined;
  const awake = ids.includes(AWAKE_ID) ? AWAKE_ID : undefined;
  if (!wake || !asleep || !awake) {
    throw new Error(`Onboarding character export needs a looping "${ASLEEP_ID}", a looping "${AWAKE_ID}" and one non-looping wake animation; found: ${ids.join(", ") || "none"}`);
  }
  return { asleep, wake, awake };
}

/** Seconds the sequence takes at the character's authored speed. */
export function sequenceDuration(definition: Definition, animationId: string): number {
  const animation = definition.animations.find((a) => a.id === animationId);
  if (!animation) return 0;
  const seconds = animation.steps.reduce((total, step) => total + (Number.isFinite(step.duration) ? Math.max(0.2, step.duration) : 1), 0);
  const speed = Number.isFinite(definition.character.speed) && definition.character.speed > 0 ? definition.character.speed : 1;
  return seconds / speed;
}

/**
 * Seconds into the sequence at which its first beat is fully reached.
 *
 * ClipLab eases every beat in from the one before it, and for the first beat
 * "before" wraps to the last — expressions are authored as loops. Played once
 * from zero, a sleepy → idle transition therefore opens on a blend of its
 * *idle* end and only settles into the sleepy pose after that ease (0.4s of
 * a 1s beat, capped at 0.45s). Seeking past it starts the one-shot asleep.
 * Mirrors sampleExpression's transition window; the step scales its
 * expression to the step duration, and speed scales everything.
 */
export function sequenceLeadIn(definition: Definition, animationId: string): number {
  const animation = definition.animations.find((a) => a.id === animationId);
  const step = animation?.steps[0];
  const expression = step && definition.expressions.find((e) => e.id === step.expressionId);
  const beat = expression?.beats[0];
  if (!animation || !step || !expression || !beat) return 0;
  const safe = (value: number) => (Number.isFinite(value) ? Math.max(0.2, value) : 1);
  const expressionSeconds = expression.beats.reduce((total, b) => total + safe(b.duration), 0);
  const transition = Math.min(0.45, safe(beat.duration) * 0.4);
  const speed = Number.isFinite(definition.character.speed) && definition.character.speed > 0 ? definition.character.speed : 1;
  return (transition * safe(step.duration)) / expressionSeconds / speed;
}

/**
 * The export's body in the agent's palette (or the presentation-only gray
 * while nothing has been hired). Everything else — shape, shading, motion,
 * follow settings — is the studio's, untouched.
 */
export function colorOnboardingDefinition(definition: Definition, appearance: AgentAppearance, muted: boolean): Definition {
  const palette: CharacterPaletteId = muted ? "muted-dream" : appearance.paletteId;
  const colors = CAP_V1_COLORS[palette];
  return { ...definition, character: { ...definition.character, color: colors.a, color2: colors.b } };
}
