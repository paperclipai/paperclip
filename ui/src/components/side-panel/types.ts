import type { ReactNode } from "react";

export type SidePanelContentMode = "padded" | "prose" | "full-bleed";
export type SidePanelPresentation = "docked" | "sheet" | "embedded";

/**
 * Serializable state owned by a side-panel host. Icons and live status are
 * deliberately projected separately into SidePanelTabItem so stored state
 * never contains React nodes.
 */
export interface SidePanelTabRecord<TPayload = unknown> {
  id: string;
  type: string;
  label: string;
  ariaLabel?: string;
  closable?: boolean;
  payload: TPayload;
  contentMode?: SidePanelContentMode;
}

/** Visual projection consumed by the domain-free tab strip. */
export interface SidePanelTabItem extends Omit<SidePanelTabRecord<unknown>, "payload"> {
  icon?: ReactNode;
  status?: ReactNode;
  disabled?: boolean;
}

export interface SidePanelTabsState<TPayload = unknown> {
  tabs: SidePanelTabRecord<TPayload>[];
  activeTabId: string | null;
}

export interface SidePanelLauncherItem {
  id: string;
  label: string;
  description?: string;
  searchText?: string;
  icon?: ReactNode;
  shortcut?: string;
  alreadyOpen?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export interface SidePanelLauncherSection {
  id: string;
  label?: string;
  items: SidePanelLauncherItem[];
  loading?: boolean;
  error?: string | null;
}
