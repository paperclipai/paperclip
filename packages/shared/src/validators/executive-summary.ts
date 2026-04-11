import { z } from "zod";
import { COMPANY_KPI_TRENDS } from "../constants.js";

export const companyKpiTrendSchema = z.enum(COMPANY_KPI_TRENDS);

export const companyKpiInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(240),
  trend: companyKpiTrendSchema.default("none"),
  note: z.string().trim().max(400).nullable().optional(),
}).strict();

export const replaceCompanyKpisSchema = z.object({
  kpis: z.array(companyKpiInputSchema).max(25),
}).strict();

export type CompanyKpiInput = z.infer<typeof companyKpiInputSchema>;
export type ReplaceCompanyKpis = z.infer<typeof replaceCompanyKpisSchema>;
