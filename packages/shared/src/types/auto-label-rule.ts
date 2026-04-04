/** Trigger events that can fire auto-label rules. */
export type AutoLabelTriggerEvent =
  | "issue.created"
  | "issue.updated"
  | "comment.created"
  | "work_product.registered";

/** Actions a rule can take on its target label. */
export type AutoLabelRuleAction = "apply" | "remove" | "toggle";

export interface AutoLabelRule {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  triggerEvent: AutoLabelTriggerEvent;
  conditionExpression: string;
  action: AutoLabelRuleAction;
  labelId: string;
  enabled: boolean;
  priority: number;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutoLabelRuleExecution {
  id: string;
  ruleId: string;
  issueId: string;
  triggerEventType: string;
  conditionResult: boolean;
  actionTaken: string | null;
  createdAt: Date;
}
