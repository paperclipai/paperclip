import { withDatabaseOperation } from "@paperclipai/db";
import type { RequestHandler } from "express";

export const databaseOperationMiddleware: RequestHandler = (_req, _res, next) =>
  withDatabaseOperation("http.request", next);
