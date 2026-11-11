import type { UI_LAYOUT_SURFACES } from "../validators/ui-layouts.js";

export type UiLayoutSurface = (typeof UI_LAYOUT_SURFACES)[number];

export interface UiLayoutPreference {
  surface: UiLayoutSurface;
  schemaVersion: number | null;
  layout: unknown;
  updatedAt: Date | null;
}
