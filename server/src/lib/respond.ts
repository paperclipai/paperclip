import type { Response } from "express";

export type RespondOptions = {
  status?: number;
};

export type RespondData<T> = T;

export function respond<T>(res: Response, data: T, options: RespondOptions = {}): void {
  const { status = 200 } = options;
  res.status(status).json(data);
}

export function respondError(
  res: Response,
  message: string,
  status: number = 400,
  details?: unknown,
): void {
  res.status(status).json({
    error: message,
    ...(details ? { details } : {}),
  });
}

export function respondCreated<T>(res: Response, data: T): void {
  respond(res, data, { status: 201 });
}

export function respondNoContent(res: Response): void {
  res.status(204).end();
}

export function respondNotFound(res: Response, message: string = "Not found"): void {
  respondError(res, message, 404);
}

export function respondUnauthorized(res: Response, message: string = "Unauthorized"): void {
  respondError(res, message, 401);
}

export function respondForbidden(res: Response, message: string = "Forbidden"): void {
  respondError(res, message, 403);
}
