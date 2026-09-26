/**
 * Public API for authoring `.canvas.tsx` files via `cursor/canvas`.
 *
 * Be creative with layout — use Grid, Row, cards, charts, tables, and raw SVG
 * in whatever combination serves the content. Read the canvas skill for full
 * design guidance. Key constraints:
 *
 * - Colors from `useHostTheme()` tokens. No hardcoded hex.
 * - No gradients, no box-shadows, no emojis as decoration.
 * - Don't wrap every section in Card — mix open sections with cards.
 * - Run the pre-delivery self-check before returning code.
 */
/** Shared category color palette used by `Swatch`, `UsageBar`, etc. */
export type { CategoryPalette, Color } from "./canvas-tokens.js";
export { categoryPaletteDark, categoryPaletteLight, colorPalette, usageColorSequence, } from "./canvas-tokens.js";
/** Charts. */
export type { BarChartProps, ChartDataPoint, ChartReferenceLine, ChartSeries, ChartTone, LineChartProps, PieChartProps, } from "./chart-primitives.js";
export { BarChart, LineChart, PieChart } from "./chart-primitives.js";
/** Borderless collapsible disclosure row with a structured header. */
export type { CollapsibleSectionProps } from "./collapsible-section.js";
export { CollapsibleSection } from "./collapsible-section.js";
/** DAG layout. */
export type { DAGLayoutEdge, DAGLayoutNode, DAGLayoutOptions, DAGLayoutRank, DAGLayoutResult, } from "./dag-layout.js";
export { computeDAGLayout } from "./dag-layout.js";
/**
 * Diff rendering. Compose with the generic `Card` family for file-level
 * chrome: use `DiffView` inside a `CardBody` (with `padding: 0`) and put
 * `DiffStats` in the enclosing `CardHeader`'s `trailing` slot.
 */
export type { DiffLineData, DiffLineType, DiffStatsProps, DiffViewProps, } from "./diff-view.js";
export { DiffStats, DiffView } from "./diff-view.js";
/** Form controls. */
export type { CheckboxProps, IconButtonProps, SelectOption, SelectProps, TextAreaProps, TextInputProps, ToggleProps, } from "./form-primitives.js";
export { Checkbox, IconButton, Select, TextArea, TextInput, Toggle, } from "./form-primitives.js";
/** Host state hooks. */
export type { CanvasAction, CanvasHostTheme, SetCanvasState } from "./hooks.js";
export { useCanvasAction, useCanvasState, useHostTheme } from "./hooks.js";
/** Colored category swatch (uses the shared `Color` palette). */
export type { SwatchProps } from "./swatch.js";
export { Swatch } from "./swatch.js";
/** Semantic design tokens for custom styling. */
export type { CanvasPalette, CanvasTokens } from "./theme.js";
export { canvasPaletteDark, canvasPaletteLight, canvasTokens, canvasTokensLight, } from "./theme.js";
export type { TodoItem, TodoListCardProps, TodoListProps, TodoStatus, } from "./todo-list.js";
export { TodoList, TodoListCard } from "./todo-list.js";
/** Component props types. */
export type { ButtonProps, CalloutProps, CalloutTone, CardBodyProps, CardHeaderProps, CardProps, CardSize, CardVariant, CodeProps, DividerProps, GridProps, H1Props, H2Props, H3Props, LinkProps, PillProps, PillSize, PillTone, RowProps, StackProps, StatProps, StatTone, TableColumnAlign, TableProps, TableRowTone, TextProps, TextWeight, } from "./ui-primitives.js";
/** Layout. */
/** Typography. */
/** Surfaces. */
/** Actions. */
/** Feedback. */
export { Button, Callout, Card, CardBody, CardHeader, Code, Divider, Grid, H1, H2, H3, Link, 
/** Shallow-merge two style objects. Useful for combining tokens with overrides. */
mergeStyle, Pill, Row, Spacer, Stack, Stat, Table, Text, } from "./ui-primitives.js";
/** Usage bar — segmented progress meter with optional labels above. */
export type { UsageBarProps, UsageBarSegment } from "./usage-bar.js";
export { UsageBar } from "./usage-bar.js";
//# sourceMappingURL=index.d.ts.map