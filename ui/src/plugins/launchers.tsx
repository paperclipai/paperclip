import type { ReactNode } from "react";

export interface PluginLauncherOutletProps {
  children?: ReactNode;
}

export function PluginLauncherOutlet({ children }: PluginLauncherOutletProps) {
  return <>{children ?? null}</>;
}
