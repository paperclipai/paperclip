/** Request header naming the person a delegate agent acts for. */
export const USER_DELEGATE_FOR_HEADER = "x-paperclip-delegate-for";
/** Request header carrying the delegate's stated reason for the action. */
export const USER_DELEGATE_REASON_HEADER = "x-paperclip-delegate-reason";
/**
 * Query-parameter equivalents for clients that cannot set headers, such as the
 * runner's `call_api` tool. Headers win when both are present.
 */
export const USER_DELEGATE_FOR_QUERY_PARAM = "delegateFor";
export const USER_DELEGATE_REASON_QUERY_PARAM = "delegateReason";
export const USER_DELEGATE_REASON_MAX_LENGTH = 500;

/** A person's active delegate agent in one company. */
export interface UserDelegate {
  id: string;
  companyId: string;
  userId: string;
  delegateAgentId: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One action group a delegate may perform for the person. */
export interface UserDelegateActionDescriptor {
  key: string;
  method: string;
  path: string;
  description: string;
}
