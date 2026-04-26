import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";

/** Returns Express middleware that validates and replaces req.body using the given Zod schema. */
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}
