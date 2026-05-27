import type {
  CreateOPCCompany,
  CreateOPCProposal,
  OPCCoachResponse,
  OPCCreateCompanyResponse,
  OPCBlueprint,
  OPCProposalDetail,
  OPCChat,
} from "@paperclipai/shared";
import { api } from "./client";

export const opcApi = {
  createProposal: (input: CreateOPCProposal) =>
    api.post<OPCProposalDetail>("/opc/proposals", input),
  getProposal: (id: string) =>
    api.get<OPCProposalDetail>(`/opc/proposals/${id}`),
  chat: (id: string, input: OPCChat) =>
    api.post<OPCCoachResponse>(`/opc/proposals/${id}/chat`, input),
  approveBlueprint: (id: string) =>
    api.post<OPCBlueprint>(`/opc/proposals/${id}/blueprint/approve`, {}),
  createCompany: (id: string, input: Partial<CreateOPCCompany> = {}) =>
    api.post<OPCCreateCompanyResponse>(`/opc/proposals/${id}/create-company`, input),
};
