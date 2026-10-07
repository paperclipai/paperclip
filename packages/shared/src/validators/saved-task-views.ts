import { z } from "zod";

export const SAVED_TASK_VIEW_NAME_MAX_LENGTH = 60;
export const SAVED_TASK_VIEW_COLLECTION_KEY_MAX_LENGTH = 200;
/**
 * A view definition is filters, sort, grouping, and display options — a few
 * hundred bytes in practice. The cap keeps an opaque JSON column from becoming
 * somewhere to park arbitrary payloads.
 */
export const SAVED_TASK_VIEW_STATE_MAX_BYTES = 16_384;

export const savedTaskViewNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SAVED_TASK_VIEW_NAME_MAX_LENGTH);

export const savedTaskViewCollectionKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(SAVED_TASK_VIEW_COLLECTION_KEY_MAX_LENGTH);

/**
 * The server stores the view definition without interpreting it: the surface
 * that owns the collection is the only thing that knows how to read it. That
 * keeps filter semantics in one place instead of duplicated server-side.
 */
export const savedTaskViewStateSchema = z
  .record(z.string(), z.unknown())
  .refine(
    // TextEncoder rather than Buffer: this module is bundled into the browser.
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= SAVED_TASK_VIEW_STATE_MAX_BYTES,
    { message: `View state must be at most ${SAVED_TASK_VIEW_STATE_MAX_BYTES} bytes` },
  );

export const createSavedTaskViewSchema = z.object({
  collectionKey: savedTaskViewCollectionKeySchema,
  name: savedTaskViewNameSchema,
  viewState: savedTaskViewStateSchema,
  position: z.number().int().min(0).optional(),
});

export const updateSavedTaskViewSchema = z
  .object({
    name: savedTaskViewNameSchema.optional(),
    viewState: savedTaskViewStateSchema.optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.viewState !== undefined || value.position !== undefined,
    { message: "Provide at least one of name, viewState, or position" },
  );

export const listSavedTaskViewsQuerySchema = z.object({
  collectionKey: savedTaskViewCollectionKeySchema.optional(),
});

export type CreateSavedTaskView = z.infer<typeof createSavedTaskViewSchema>;
export type UpdateSavedTaskView = z.infer<typeof updateSavedTaskViewSchema>;
export type ListSavedTaskViewsQuery = z.infer<typeof listSavedTaskViewsQuerySchema>;
