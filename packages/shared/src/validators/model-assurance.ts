import { z } from "zod";
import {
  MODEL_ASSURANCE_MODEL_SOURCES,
  MODEL_ASSURANCE_POLICY_STATUSES,
  MODEL_ASSURANCE_REASON_CODES,
  MODEL_ASSURANCE_ROLE_FITS,
} from "../constants.js";

export const modelAssuranceModelSourceSchema = z.enum(MODEL_ASSURANCE_MODEL_SOURCES);
export const modelAssurancePolicyStatusSchema = z.enum(MODEL_ASSURANCE_POLICY_STATUSES);
export const modelAssuranceRoleFitSchema = z.enum(MODEL_ASSURANCE_ROLE_FITS);
export const modelAssuranceReasonCodeSchema = z.enum(MODEL_ASSURANCE_REASON_CODES);
