import type {
  Agent,
  AppGalleryEntry,
  ToolCallEvent,
  ToolConnectionActivityResponse,
  ToolConnectionLifecycleEvent,
  ToolCatalogEntry,
  ToolConnection,
} from "@paperclipai/shared";

export type AccessDraft = { mode: "all" | "specific"; agentIds: Set<string> };

export interface AppDetailSectionProps {
  connectionId: string;
  connection: ToolConnection;
  appName: string;
  galleryEntry: AppGalleryEntry | null;
  catalog: ToolCatalogEntry[];
  active: ToolCatalogEntry[];
  readOnly: ToolCatalogEntry[];
  canChange: ToolCatalogEntry[];
  quarantined: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  access: AccessDraft;
  agents: Agent[];
  pending: boolean;
}

export interface ActivityPanelProps {
  events: ToolCallEvent[];
  lifecycleEvents: ToolConnectionLifecycleEvent[];
  issues: ToolConnectionActivityResponse["issues"];
  actionRequests: ToolConnectionActivityResponse["actionRequests"];
  loading: boolean;
  agents: Agent[];
  connectionId: string;
  appName: string;
}
