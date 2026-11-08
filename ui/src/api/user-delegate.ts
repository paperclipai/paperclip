import type { SetUserDelegate, UserDelegate, UserDelegateActionDescriptor } from "@paperclipai/shared";
import { api } from "./client";

export interface UserDelegateState {
  delegate: UserDelegate | null;
  actions: UserDelegateActionDescriptor[];
}

/**
 * "My delegate": the one agent that may act as me on the listed person-only
 * actions in this company. Only the signed-in person can change or turn it off.
 */
export const userDelegateApi = {
  getMine: (companyId: string) =>
    api.get<UserDelegateState>(`/companies/${companyId}/users/me/delegate`),
  setMine: (companyId: string, input: SetUserDelegate) =>
    api.put<UserDelegateState>(`/companies/${companyId}/users/me/delegate`, input),
  clearMine: (companyId: string) =>
    api.delete<UserDelegateState>(`/companies/${companyId}/users/me/delegate`),
};
