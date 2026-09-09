import type { ViewportState, ScreenPoint } from "./types";
import type { AnnotationBBox } from "../../hooks/useAnnotationWebSocket";

/** Convert geographic [lng, lat] to screen pixel coordinates. */
export function projectToScreen(lng: number, lat: number, vp: ViewportState): ScreenPoint {
  const x = vp.width / 2 + (lng - vp.centerLng) * vp.scale;
  const y = vp.height / 2 - (lat - vp.centerLat) * vp.scale;
  return { x, y };
}

/** Convert screen pixel to geographic [lng, lat]. */
export function unprojectFromScreen(x: number, y: number, vp: ViewportState): { lng: number; lat: number } {
  const lng = vp.centerLng + (x - vp.width / 2) / vp.scale;
  const lat = vp.centerLat - (y - vp.height / 2) / vp.scale;
  return { lng, lat };
}

/** Compute the bounding box of the current viewport. */
export function viewportToBBox(vp: ViewportState): AnnotationBBox {
  const halfW = vp.width / 2 / vp.scale;
  const halfH = vp.height / 2 / vp.scale;
  return {
    minLng: vp.centerLng - halfW,
    minLat: vp.centerLat - halfH,
    maxLng: vp.centerLng + halfW,
    maxLat: vp.centerLat + halfH,
  };
}
