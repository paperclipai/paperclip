export type PaperclipSemanticActionId =
  | "get_task_context"
  | "get_task_history"
  | "list_documents"
  | "read_document"
  | "list_document_revisions"
  | "report_progress"
  | "answer_status_question"
  | "write_document"
  | "request_human_input"
  | "register_deliverable"
  | "finish_task"
  | "block_task"
  | "request_review"
  | "list_agents"
  | "get_agent"
  | "search_tasks"
  | "list_approvals"
  | "get_approval"
  | "get_approval_context"
  | "get_workspace_runtime"
  | "control_workspace_service"
  | "set_dependencies"
  | "create_task"
  | "request_approval"
  | "decide_approval"
  | "comment_on_approval"
  | "schedule_wake";

export type PaperclipSemanticActionPlacement = "always" | "optional";
export type PaperclipSemanticActionMode =
  "standard" | "ask" | "planning" | "skill_test";
export type PaperclipSemanticActionEffect = "read" | "write" | "governance";

export type PaperclipJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PaperclipJsonValue[]
  | { readonly [key: string]: PaperclipJsonValue };

/** The JSON Schema subset used by the v1 semantic action catalog. */
export interface PaperclipJsonSchema {
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, PaperclipJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | PaperclipJsonSchema;
  readonly items?: PaperclipJsonSchema;
  readonly enum?: readonly PaperclipJsonValue[];
  readonly oneOf?: readonly PaperclipJsonSchema[];
  readonly anyOf?: readonly PaperclipJsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: PaperclipJsonValue;
}

/**
 * A transport-neutral declaration. Catalog membership never grants discovery
 * or invocation authority; a run-scoped authorization layer must do that.
 */
export interface PaperclipSemanticActionDescriptor {
  readonly schema: "paperclip.semantic-action.v1";
  readonly operationId: PaperclipSemanticActionId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly placement: PaperclipSemanticActionPlacement;
  readonly effect: PaperclipSemanticActionEffect;
  readonly requiredClaims: readonly string[];
  readonly allowedModes: readonly PaperclipSemanticActionMode[];
  readonly allowedRoles?: readonly string[];
  readonly inputSchema: PaperclipJsonSchema;
  readonly outputSchema: PaperclipJsonSchema;
}
