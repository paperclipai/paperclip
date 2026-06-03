import { z } from "zod";

export const updateLabelSchema = z
  .object({
    name: z.string().trim().min(1).max(48).optional(),
    color: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value")
      .optional(),
    description: z.string().max(2048).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.color !== undefined
      || value.description !== undefined,
    "At least one label field must be provided",
  );

export type UpdateLabel = z.infer<typeof updateLabelSchema>;
