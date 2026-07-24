import type { Request, Response, NextFunction } from "express";
import { ZodError, ZodObject, type ZodSchema } from "zod";
import { badRequest } from "../errors.js";

function topLevelKeys(schema: ZodSchema): string[] | null {
  if (!(schema instanceof ZodObject)) return null;
  return Object.keys(schema.shape).sort();
}

// A strict schema reports unknown keys as `unrecognized_keys` issues. Surface them as a 400
// that names the offending field: a silent strip returns 200 while dropping the write, which
// reads as "the field exists and I set it" when in fact the field does not exist at all.
function unknownFieldError(schema: ZodSchema, error: ZodError) {
  const unrecognized = error.errors.filter((issue) => issue.code === "unrecognized_keys");
  if (unrecognized.length === 0) return null;

  // Only claim the error when an unknown key is the *only* problem. A body can trip a strict
  // schema and a substantive rule at once — posting `config.accessKeyId` to a secret provider
  // raises both an unrecognized key and "cannot persist sensitive field". The schema's own
  // message is the more specific one, so leave those to the standard ZodError rendering rather
  // than flattening them into a generic "unknown field".
  if (unrecognized.length !== error.errors.length) return null;

  const names = unrecognized.flatMap((issue) =>
    issue.keys.map((key) => [...issue.path, key].join(".")),
  );
  const plural = names.length === 1 ? "field" : "fields";
  const allowed = unrecognized.every((issue) => issue.path.length === 0)
    ? topLevelKeys(schema)
    : null;

  return badRequest(
    `Unknown ${plural}: ${names.join(", ")}. This endpoint does not accept ` +
      `${names.length === 1 ? "that field" : "those fields"} and will not store ` +
      `${names.length === 1 ? "it" : "them"}.` +
      (allowed ? ` Accepted fields: ${allowed.join(", ")}.` : ""),
    { unknownFields: names, ...(allowed ? { acceptedFields: allowed } : {}) },
  );
}

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        const unknownField = unknownFieldError(schema, error);
        if (unknownField) throw unknownField;
      }
      throw error;
    }
    next();
  };
}
