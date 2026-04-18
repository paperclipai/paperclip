export interface ChartBounds {
  width: number;
  height: number;
}

export interface ChartTransform {
  pan: { x: number; y: number };
  zoom: number;
}

export function calculateFitTransform(
  containerWidth: number,
  containerHeight: number,
  bounds: ChartBounds,
): ChartTransform | null {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return null;
  }

  const scaleX = (containerWidth - 40) / bounds.width;
  const scaleY = (containerHeight - 40) / bounds.height;
  const fitZoom = Math.min(scaleX, scaleY, 1);
  const chartW = bounds.width * fitZoom;
  const chartH = bounds.height * fitZoom;

  return {
    zoom: fitZoom,
    pan: {
      x: (containerWidth - chartW) / 2,
      y: (containerHeight - chartH) / 2,
    },
  };
}
