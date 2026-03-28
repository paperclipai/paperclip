import type { IssueLinkType } from "../constants.js";

export interface IssueLink {
  id: string;
  companyId: string;
  sourceId: string;
  targetId: string;
  linkType: IssueLinkType;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface IssueLinkWithDetails {
  id: string;
  linkType: IssueLinkType;
  sourceId: string;
  sourceIdentifier: string;
  sourceTitle: string;
  sourceStatus: string;
  targetId: string;
  targetIdentifier: string;
  targetTitle: string;
  targetStatus: string;
  createdAt: Date;
}

export interface IssueLinksByDirection {
  outgoing: IssueLinkWithDetails[];
  incoming: IssueLinkWithDetails[];
}
