import { forbidden, unauthorized, type HttpError } from "../errors.js";
import {
  authorizeCompanyAccess,
  type CompanyAuthorization,
  type HttpActor,
} from "./actor-context.js";

export type HttpAuthorization = {
  actor: HttpActor;
  method: string;
  requireCompany(companyId: string): HttpActor;
  require(allowed: boolean, error: HttpError): void;
};

function throwAuthorizationFailure(result: Exclude<CompanyAuthorization, { allowed: true }>): never {
  if (result.status === 401) throw unauthorized(result.message);
  throw forbidden(result.message, result.code ? { code: result.code } : undefined);
}

/**
 * Handler-facing authorization helper. Credential resolution happens outside
 * this pure boundary; this object only applies the already-authenticated actor
 * policy and turns denials into the existing HttpError hierarchy.
 */
export function createHttpAuthorization(
  actor: HttpActor,
  method: string,
): HttpAuthorization {
  return {
    actor,
    method,
    requireCompany(companyId) {
      const result = authorizeCompanyAccess(actor, companyId, method);
      if (!result.allowed) throwAuthorizationFailure(result);
      return actor;
    },
    require(allowed, error) {
      if (!allowed) throw error;
    },
  };
}
