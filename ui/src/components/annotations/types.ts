export interface ViewportState {
  /** Center longitude */
  centerLng: number;
  /** Center latitude */
  centerLat: number;
  /** Pixels per degree longitude */
  scale: number;
  /** Canvas width in pixels */
  width: number;
  /** Canvas height in pixels */
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export type DrawTool = "select" | "point" | "line" | "polygon";
