import type { Issue } from "./issue.js";

export interface IssueFavourite {
  id: string;
  companyId: string;
  issueId: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  issue: Issue;
}
