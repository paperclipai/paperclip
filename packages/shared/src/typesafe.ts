import { z } from "zod";

const structured = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
const criterion = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
const question = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      instructions: structured,
      criteria: z.object({ true: criterion.optional(), false: criterion.optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: structured,
      criteria: z.record(z.string().min(1), criterion.nullable()).refine((value) => {
        const size = Object.keys(value).length;
        return size >= 1 && size <= 255;
      }, "A choice needs 1 to 255 options"),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: structured,
      criteria: z.array(criterion).min(2).max(10),
    })
    .strict(),
]);

export const typesafeAskSchema = z
  .object({
    state: structured,
    questions: z
      .record(z.string().min(1), question)
      .refine((value) => Object.keys(value).length >= 1, "At least one question is required"),
    model: z.string().min(1).max(100).optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict();
export type TypesafeAsk = z.infer<typeof typesafeAskSchema>;

export type TypesafeAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };
export interface TypesafeAskResult {
  model: string;
  answers: Record<string, TypesafeAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
