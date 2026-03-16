import type { ReactNode } from "react";

export interface PluginSlot {
  id: string;
  pluginKey: string;
  displayName: string;
}

export interface UsePluginSlotsOptions {
  slotTypes?: string[];
  entityType?: string;
  companyId?: string | null;
  enabled?: boolean;
}

export interface UsePluginSlotsResult {
  slots: PluginSlot[];
  isLoading: boolean;
}

export function usePluginSlots(_options: UsePluginSlotsOptions): UsePluginSlotsResult {
  return { slots: [], isLoading: false };
}

export interface PluginSlotMountProps {
  children?: ReactNode;
}

export function PluginSlotMount({ children }: PluginSlotMountProps) {
  return <>{children ?? null}</>;
}

export interface PluginSlotOutletProps {
  children?: ReactNode;
}

export function PluginSlotOutlet({ children }: PluginSlotOutletProps) {
  return <>{children ?? null}</>;
}
