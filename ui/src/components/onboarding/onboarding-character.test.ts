import { describe, expect, it } from "vitest";
import { appearanceForPalette } from "@paperclipai/shared";
import { CAP_V1_COLORS } from "@paperclipai/shared/cliplab/palette-tokens";
import { PAPERCLIP_CHARACTER } from "@paperclipai/shared/cliplab/character";
import exported from "@/assets/cliplab/onboarding.character.json";
import { colorOnboardingDefinition, resolveOnboardingSequences, sequenceDuration, sequenceLeadIn } from "./onboarding-character";

const definition = PAPERCLIP_CHARACTER;

describe("onboarding character export", () => {
  it("is the same export the shared engine renders everywhere", () => {
    expect(JSON.parse(JSON.stringify(PAPERCLIP_CHARACTER))).toEqual(exported);
  });

  it("carries the three sequences the arc plays, with the wake as its one-shot", () => {
    const sequences = resolveOnboardingSequences(definition);
    expect(sequences).toEqual({ asleep: "sleepy", wake: expect.any(String), awake: "idle" });
    const byId = new Map(definition.animations.map((a) => [a.id, a]));
    expect(byId.get(sequences.asleep)?.loop).toBe(true);
    expect(byId.get(sequences.awake)?.loop).toBe(true);
    expect(byId.get(sequences.wake)?.loop).toBe(false);
    // Every step points at an expression the export actually ships.
    const expressions = new Set(definition.expressions.map((e) => e.id));
    for (const animation of definition.animations) for (const step of animation.steps) expect(expressions.has(step.expressionId)).toBe(true);
  });

  it("refuses an export missing a role rather than guessing", () => {
    expect(() => resolveOnboardingSequences({ animations: definition.animations.filter((a) => a.loop) })).toThrow(/non-looping wake/);
    expect(() => resolveOnboardingSequences({ animations: [] })).toThrow(/found: none/);
  });

  it("times the wake from its authored steps at the character's speed", () => {
    const { wake } = resolveOnboardingSequences(definition);
    const authored = definition.animations.find((a) => a.id === wake)!.steps.reduce((n, s) => n + s.duration, 0);
    expect(sequenceDuration(definition, wake)).toBeCloseTo(authored / definition.character.speed);
    expect(sequenceDuration({ ...definition, character: { ...definition.character, speed: 2 } }, wake)).toBeCloseTo(authored / 2);
    expect(sequenceDuration(definition, "missing")).toBe(0);
  });

  it("skips the wake's wrap-around ease so it opens on its first beat", () => {
    const { wake } = resolveOnboardingSequences(definition);
    const animation = definition.animations.find((a) => a.id === wake)!;
    const expression = definition.expressions.find((e) => e.id === animation.steps[0]!.expressionId)!;
    const beat = expression.beats[0]!;
    const expressionSeconds = expression.beats.reduce((n, b) => n + b.duration, 0);
    const transition = Math.min(0.45, beat.duration * 0.4);
    expect(sequenceLeadIn(definition, wake)).toBeCloseTo((transition * animation.steps[0]!.duration) / expressionSeconds / definition.character.speed);
    expect(sequenceLeadIn(definition, wake)).toBeLessThan(sequenceDuration(definition, wake));
    expect(sequenceLeadIn(definition, "missing")).toBe(0);
  });

  it("recolours only the body, gray before the hire and the palette after", () => {
    const appearance = appearanceForPalette("coral-mint");
    const asleep = colorOnboardingDefinition(definition, appearance, true);
    const awake = colorOnboardingDefinition(definition, appearance, false);
    expect([asleep.character.color, asleep.character.color2]).toEqual([CAP_V1_COLORS["muted-dream"].a, CAP_V1_COLORS["muted-dream"].b]);
    expect([awake.character.color, awake.character.color2]).toEqual([CAP_V1_COLORS["coral-mint"].a, CAP_V1_COLORS["coral-mint"].b]);
    const { color: _a, color2: _b, ...rest } = awake.character;
    const { color: _c, color2: _d, ...original } = definition.character;
    expect(rest).toEqual(original);
    expect(awake.expressions).toBe(definition.expressions);
    // The source is never mutated.
    expect(definition.character.color).not.toBe(awake.character.color);
  });
});
