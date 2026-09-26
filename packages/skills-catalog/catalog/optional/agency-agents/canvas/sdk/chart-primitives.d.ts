/**
 * Chart primitives for `cursor/canvas` — multi-series, stacked, and pie charts
 * rendered as pure inline SVG with zero external dependencies.
 *
 * Distilled from the portal-website Highcharts analytics charting layer.
 */
import type { CSSProperties, JSX } from "react";
/**
 * Semantic tone for a chart series or slice. Mirrors the tone vocabulary
 * used by `Stat`, `Pill`, `Table`, and other SDK primitives so colors
 * match across a canvas — e.g. a `Stat tone="success"` and a
 * `ChartSeries tone="success"` render in the same green.
 *
 * Omit `tone` to let the chart auto-assign a distinct color from the
 * chart palette; supply `tone` only when the value carries semantic
 * meaning that should match other tonal elements on the page.
 */
export type ChartTone = "success" | "danger" | "warning" | "info" | "neutral";
/** A single labeled value, used by `PieChart`. */
export type ChartDataPoint = {
    label: string;
    /** Non-negative numeric value. */
    value: number;
};
/**
 * A named data series for `BarChart` and `LineChart`.
 * The `data` array aligns by index with the parent component's `categories`.
 * If `tone` is omitted, a color is auto-assigned from the chart palette.
 */
export type ChartSeries = {
    name: string;
    data: number[];
    tone?: ChartTone;
};
/**
 * A dashed marker line drawn across the plot at a fixed value — for targets,
 * SLOs, budgets, means, or limits. Drawn horizontally on line / vertical-bar
 * charts and vertically on `horizontal` bar charts; either way it marks the
 * value axis and is folded into the auto domain so it stays on-canvas.
 */
export type ChartReferenceLine = {
    /** Position on the value axis, in the same units as the series data. */
    value: number;
    /** Short label drawn in a chip at the line's end. */
    label?: string;
    /** Line color. Omit for a muted neutral; set to match other tonal elements. */
    tone?: ChartTone;
};
/**
 * Shared value-axis controls (the y-axis, or the x-axis on `horizontal` bar
 * charts). By default the axis starts at zero; override to zoom into a tight
 * range. On stacked / normalized bars these are ignored — those always start
 * at zero.
 */
type ValueAxisProps = {
    /**
     * Start the value axis at zero. Defaults to `true`. Set `false` to
     * auto-fit the axis to the data range — useful for tightly-clustered
     * series (e.g. uptime 99.0–99.9%) that a zero baseline would flatten.
     */
    beginAtZero?: boolean;
    /** Explicit axis minimum. Overrides `beginAtZero`. */
    yMin?: number;
    /** Explicit axis maximum. */
    yMax?: number;
    /** Horizontal marker lines for targets / thresholds / means. */
    referenceLines?: ChartReferenceLine[];
};
export type BarChartProps = ValueAxisProps & {
    /** Category labels along the independent axis. */
    categories: string[];
    /** One or more data series. Values align by index with `categories`. */
    series: ChartSeries[];
    height?: number;
    /** Stack series on top of each other instead of grouping side-by-side. */
    stacked?: boolean;
    /** Render horizontal bars instead of vertical columns. */
    horizontal?: boolean;
    /** Show as 100% stacked (implies `stacked`). */
    normalized?: boolean;
    /** Suffix for value labels (e.g. "%", " ms"). */
    valueSuffix?: string;
    /** Prefix for value labels (e.g. "$"). Ignored in `normalized` mode. */
    valuePrefix?: string;
    /**
     * Print each bar's value as a label. Defaults to auto: on for a single
     * series with ≤8 categories, off otherwise. Set `true` to force labels on
     * (e.g. grouped multi-series), or `false` to force them off. No effect on
     * `stacked` / `normalized` charts — use the hover tooltip there.
     */
    showValues?: boolean;
    style?: CSSProperties;
};
export type LineChartProps = ValueAxisProps & {
    categories: string[];
    series: ChartSeries[];
    height?: number;
    /** Fill the area under each line with a soft tint. */
    fill?: boolean;
    /** Suffix for value labels (e.g. "%", " ms"). */
    valueSuffix?: string;
    /** Prefix for value labels (e.g. "$"). */
    valuePrefix?: string;
    /** Print the value next to every data point (≤20 categories). */
    showValues?: boolean;
    /** Draw a vertical guide through the cursor while hovering. Defaults to `true`. */
    showHoverGuide?: boolean;
    style?: CSSProperties;
};
export type PieChartProps = {
    data: Array<ChartDataPoint & {
        tone?: ChartTone;
    }>;
    /** Diameter in px. Defaults to 200. */
    size?: number;
    /** Render as a donut with the summed total shown in the hollow center. */
    donut?: boolean;
    style?: CSSProperties;
};
/**
 * Multi-series bar/column chart with optional stacking and normalization.
 * Distilled from the portal-website Highcharts analytics charts.
 *
 * Pass `categories` for x-axis labels and one or more `series` whose `data`
 * arrays align by index. With a single series you get simple bars; with
 * multiple series the default is grouped (side-by-side) — set `stacked` for
 * stacked columns or `normalized` for 100%-stacked share-mode.
 *
 * Colors are auto-assigned from the chart palette. With a **single series**,
 * each bar gets a different color by category (so a chart of 5 categories
 * shows 5 colors out of the box). With **multiple series**, each series gets
 * its own color. A legend appears when there are 2+ series.
 *
 * For semantic coloring, pass `tone` on a series — it maps to the same
 * palette entries used by `Stat`, `Pill`, and `Table` so your chart matches
 * tonal elements elsewhere on the page.
 *
 * @example
 * ```tsx
 * // Simple single-series
 * <BarChart
 *   categories={["Mon", "Tue", "Wed"]}
 *   series={[{ name: "Requests", data: [120, 90, 150] }]}
 * />
 *
 * // Stacked multi-series (like portal AI commit chart)
 * <BarChart
 *   categories={["Mon", "Tue", "Wed"]}
 *   series={[
 *     { name: "IDE", data: [120, 90, 150] },
 *     { name: "CLI", data: [30, 40, 25] },
 *     { name: "Cloud", data: [50, 60, 70] },
 *   ]}
 *   stacked
 * />
 *
 * // Semantic tones — "accepted" renders in the same green as
 * // <Stat tone="success"> elsewhere on the page.
 * <BarChart
 *   categories={["Mon", "Tue", "Wed"]}
 *   series={[
 *     { name: "Accepted", data: [70, 80, 60], tone: "success" },
 *     { name: "Rejected", data: [30, 20, 40], tone: "danger" },
 *   ]}
 *   stacked
 * />
 *
 * // Mark a target with a reference line. Grouped/single bars also accept
 * // `yMin` / `yMax` to frame the axis (stacked bars stay zero-based).
 * <BarChart
 *   categories={["Mon", "Tue", "Wed", "Thu", "Fri"]}
 *   series={[{ name: "Latency", data: [180, 210, 240, 200, 220] }]}
 *   valueSuffix=" ms"
 *   referenceLines={[{ value: 200, label: "Budget", tone: "warning" }]}
 * />
 * ```
 */
export declare function BarChart({ categories, series, height, stacked, horizontal, normalized, valueSuffix, valuePrefix, showValues, beginAtZero, yMin, yMax, referenceLines, style }: BarChartProps): JSX.Element;
/**
 * Multi-series line chart with optional area fill. Distilled from the
 * portal-website Highcharts analytics charts.
 *
 * Each series draws a polyline with dot markers at each data point.
 * Set `fill` to shade the area under every line. Hover over any category
 * column to see a tooltip with all series values and a vertical cursor guide.
 *
 * This is **not** a time-series component — it does not parse dates.
 * Pass pre-formatted date strings as `categories` if plotting over time.
 *
 * Colors are auto-assigned from the chart palette. For semantic coloring,
 * pass `tone` on a series — it maps to the same palette entries used by
 * `Stat`, `Pill`, and `Table`.
 *
 * @example
 * ```tsx
 * // Single line
 * <LineChart
 *   categories={["Jan", "Feb", "Mar", "Apr"]}
 *   series={[{ name: "Revenue", data: [100, 140, 120, 180] }]}
 * />
 *
 * // Multi-series with area fill
 * <LineChart
 *   categories={["Jan", "Feb", "Mar", "Apr"]}
 *   series={[
 *     { name: "Accepted", data: [50, 70, 60, 90] },
 *     { name: "Suggested", data: [120, 140, 130, 160] },
 *   ]}
 *   fill
 * />
 *
 * // Semantic tones — "errors" renders in the same red as a
 * // <Pill tone="danger"> elsewhere on the page.
 * <LineChart
 *   categories={["00:00", "06:00", "12:00", "18:00"]}
 *   series={[
 *     { name: "p95 latency", data: [80, 95, 110, 90], tone: "info" },
 *     { name: "errors", data: [2, 4, 9, 3], tone: "danger" },
 *   ]}
 * />
 *
 * // Zoom into a tight range and mark an SLO. `beginAtZero={false}`
 * // auto-fits the axis; `referenceLines` draws the target.
 * <LineChart
 *   categories={["Mon", "Tue", "Wed", "Thu", "Fri"]}
 *   series={[{ name: "Uptime", data: [99.91, 99.95, 99.7, 99.99, 99.96] }]}
 *   valueSuffix="%"
 *   beginAtZero={false}
 *   referenceLines={[{ value: 99.9, label: "SLO", tone: "danger" }]}
 * />
 * ```
 */
export declare function LineChart({ categories, series, height, fill, valueSuffix, valuePrefix, showValues, showHoverGuide, beginAtZero, yMin, yMax, referenceLines, style }: LineChartProps): JSX.Element;
/**
 * Pie (or donut) chart with hover highlighting. Distilled from the
 * portal-website Highcharts analytics charts.
 *
 * Unlike `BarChart` and `LineChart`, `PieChart` takes a flat `data` array of
 * `{ label, value }` points — each slice is its own category. Colors are
 * auto-assigned from the chart palette; pass `tone` on a point to give a
 * slice a semantic color that matches other tonal elements on the page.
 *
 * Hovering a slice expands it outward and dims the others; hovering a legend
 * item does the same. A tooltip with value and percentage appears below the
 * chart. Set `donut` for a hollow center that shows the summed total.
 *
 * **Do not** use for bar-style comparisons — use `BarChart` instead.
 *
 * @example
 * ```tsx
 * // Basic pie
 * <PieChart
 *   data={[
 *     { label: "IDE", value: 120 },
 *     { label: "CLI", value: 30 },
 *     { label: "Cloud", value: 50 },
 *   ]}
 * />
 *
 * // Donut with semantic tones
 * <PieChart
 *   data={[
 *     { label: "Passing", value: 70, tone: "success" },
 *     { label: "Failing", value: 30, tone: "danger" },
 *   ]}
 *   donut
 * />
 * ```
 */
export declare function PieChart({ data, size, donut, style }: PieChartProps): JSX.Element;
export {};
//# sourceMappingURL=chart-primitives.d.ts.map