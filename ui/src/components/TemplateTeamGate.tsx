// TEMPORARY passthrough stub so `pnpm dev:ui` builds. Your in-progress App.tsx
// imports this path but the real component isn't written yet. NOT part of the
// Org/Office feature and NOT committed — delete it (or replace with your real
// TemplateTeamGate) whenever you resume that work.
import type { ReactNode } from "react";

export function TemplateTeamGate({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
