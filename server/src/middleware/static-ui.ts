import express, { type RequestHandler } from "express";
import { completeIdleReadOnlyResponse } from "./idle-admission.js";

export function staticUiFiles(root: string, options: Parameters<typeof express.static>[1] = {}): RequestHandler {
  const matches = new WeakMap<object, () => void>();
  const serve = express.static(root, {
    ...options,
    setHeaders(res, filePath, stat) {
      options?.setHeaders?.(res, filePath, stat);
      matches.get(res)?.();
    },
  });
  return (req, res, next) => {
    const application = req.app;
    let matched = false;
    const cleanup = () => {
      matches.delete(res);
      res.off("finish", complete);
      res.off("close", complete);
    };
    const complete = () => {
      if (!matched) return;
      cleanup();
      completeIdleReadOnlyResponse(req, application);
    };
    const forward = (error?: unknown) => {
      cleanup();
      if (matched && res.destroyed) {
        completeIdleReadOnlyResponse(req, application);
        return;
      }
      next(error);
    };
    matches.set(res, () => {
      matched = true;
      if (res.destroyed) complete();
    });
    res.once("finish", complete);
    res.once("close", complete);
    try {
      serve(req, res, forward);
    } catch (error) {
      forward(error);
    }
  };
}
