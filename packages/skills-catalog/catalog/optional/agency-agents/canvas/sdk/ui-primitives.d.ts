/**
 * UI primitives for `cursor/canvas`. Styling follows the Cursor dark theme; no extra packages required.
 */
import { type CSSProperties, type JSX, type ReactNode } from "react";
/**
 * Shallow-merge style objects with `override` taking precedence.
 *
 * Use for small tweaks on built-in components (e.g. extra padding or width).
 * **Do not** use this to build elaborate custom chrome — prefer the built-in
 * components and flat solid token colors. No gradients, no box-shadows.
 *
 * @example
 * ```tsx
 * // Good — minor override on a built-in component
 * <CardBody style={mergeStyle({ padding: 16 })}>…</CardBody>
 *
 * // Bad — hand-rolled decorative styling
 * <div style={mergeStyle(base, { background: "linear-gradient(…)" })}>…</div>
 * ```
 */
export declare function mergeStyle(base: CSSProperties, override?: CSSProperties): CSSProperties;
export type StackProps = {
    children?: ReactNode;
    gap?: number;
    style?: CSSProperties;
};
/**
 * Vertical flex column. Use as the top-level page wrapper or to stack cards/sections.
 *
 * @example
 * ```tsx
 * <Stack gap={16}>
 *   <H1>Dashboard</H1>
 *   <Card>…</Card>
 *   <Card>…</Card>
 * </Stack>
 * ```
 */
export declare function Stack({ children, gap, style }: StackProps): JSX.Element;
export type RowProps = {
    children?: ReactNode;
    gap?: number;
    align?: "start" | "center" | "end" | "stretch";
    justify?: "start" | "center" | "end" | "space-between";
    wrap?: boolean;
    style?: CSSProperties;
};
/**
 * Horizontal flex row. Use for inline groups of buttons, badges, or metadata.
 *
 * @example
 * ```tsx
 * <Row gap={8} align="center">
 *   <Button variant="primary">Save</Button>
 *   <Button variant="ghost">Cancel</Button>
 * </Row>
 * ```
 */
export declare function Row({ children, gap, align, justify, wrap, style }: RowProps): JSX.Element;
/**
 * CSS Grid with tokenized gap. Prefer this over `Row` + `wrap` when you need a
 * fixed number of equal-width columns: wrapped flex items can land on their
 * own row and grow to full width (`flex-grow`), which is often surprising for
 * boards and dashboards.
 */
export type GridProps = {
    children?: ReactNode;
    /**
     * Equal columns: pass a number (uses `repeat(n, minmax(0, 1fr))`), or a CSS
     * `grid-template-columns` string (e.g. `"1fr 2fr"` or `"minmax(0, 200px) 1fr"`).
     */
    columns: number | string;
    gap?: number;
    align?: "start" | "center" | "end" | "stretch";
    style?: CSSProperties;
};
export declare function Grid({ children, columns, gap, align, style }: GridProps): JSX.Element;
export type DividerProps = {
    style?: CSSProperties;
};
/**
 * Horizontal line for visually separating sections. Uses `stroke.tertiary`
 * to match the Card/Table hairline weight.
 *
 * @example
 * ```tsx
 * <Stack>
 *   <Text>Section one</Text>
 *   <Divider />
 *   <Text>Section two</Text>
 * </Stack>
 * ```
 */
export declare function Divider({ style }: DividerProps): JSX.Element;
/**
 * Flex spacer that pushes siblings apart. Place inside a `Row` to push
 * trailing content to the right edge.
 *
 * @example
 * ```tsx
 * <Row>
 *   <Text>Title</Text>
 *   <Spacer />
 *   <Button variant="primary">Save</Button>
 * </Row>
 * ```
 */
export declare function Spacer(): JSX.Element;
/** Horizontal alignment for a table column. */
export type TableColumnAlign = "left" | "center" | "right";
/** Semantic tone for a table row — marker dot in the first column. */
export type TableRowTone = "success" | "danger" | "warning" | "info" | "neutral";
export type TableProps = {
    /** Column titles, left to right. Column count is fixed by this array. */
    headers: ReactNode[];
    /**
     * Body rows. Each row is an array of cells in the same order as `headers`.
     * Shorter rows are padded with empty cells; extra cells are ignored.
     */
    rows: ReactNode[][];
    /** Optional alignment per column index (headers/rows). Defaults to left. */
    columnAlign?: Array<TableColumnAlign | undefined>;
    /**
     * Optional semantic tone per row index. Renders a small colored dot before
     * the first column's content (no row fill or border). Sparse: `undefined`
     * entries are unstyled.
     */
    rowTone?: Array<TableRowTone | undefined>;
    /** When true (default), bordered rounded shell with horizontal scroll if needed. */
    framed?: boolean;
    /** Alternate subtle fill on even rows for easier scanning in large tables. */
    striped?: boolean;
    /** Stick the header row when the framed container scrolls vertically. */
    stickyHeader?: boolean;
    style?: CSSProperties;
    /** Shown in a single spanning cell when `rows` is empty. */
    emptyMessage?: ReactNode;
};
/**
 * Data table with column headers and rows. Framed by default with its own
 * bordered container — **do not wrap in a Card** unless the card itself is
 * a named entity that happens to contain a table. Render directly under a
 * heading in the normal case.
 *
 * @example
 * ```tsx
 * // Good — table directly under a heading
 * <H2>Active services</H2>
 * <Table
 *   headers={["Service", "Status", "RPS"]}
 *   rows={[
 *     ["api-gateway", "Steady", "3.2k"],
 *     ["workers", "Hot", "8.1k"],
 *   ]}
 *   columnAlign={["left", "left", "right"]}
 * />
 *
 * // Allowed — table inside a named-entity card
 * <Card>
 *   <CardHeader>billing-service</CardHeader>
 *   <CardBody><Table headers={…} rows={…} /></CardBody>
 * </Card>
 * ```
 */
export declare function Table({ headers, rows, columnAlign, rowTone, framed, striped, stickyHeader, style, emptyMessage }: TableProps): JSX.Element;
export type TextWeight = "normal" | "medium" | "semibold" | "bold";
export type TextProps = {
    children?: ReactNode;
    tone?: "primary" | "secondary" | "tertiary" | "quaternary";
    size?: "body" | "small";
    /**
     * Element tag to render. Defaults to `"p"` for top-level body copy and
     * automatically switches to `"span"` when nested inside another typography
     * container so inline emphasis stays valid HTML.
     */
    as?: "p" | "span";
    /** Font weight. Default is `"normal"` (400). Use `"semibold"` or `"bold"` for emphasis. */
    weight?: TextWeight;
    /** Render as italic. */
    italic?: boolean;
    /**
     * Truncate overflowing text with an ellipsis on a single line.
     * - `true` / `"end"` — ellipsis at the end (default truncation).
     * - `"start"` — ellipsis at the start. Useful for file paths where the
     *   filename matters more than the directory prefix.
     *
     * Requires the parent to have a bounded width (flex child with
     * `minWidth: 0`, fixed width, etc.) — otherwise the text just expands
     * and never overflows.
     */
    truncate?: boolean | "start" | "end";
    style?: CSSProperties;
};
/**
 * Body text with tone, size, weight, and italic variants.
 *
 * Top-level `Text` renders a `<p>`. Nested `Text` automatically renders a
 * `<span>` so inline emphasis like `<Text>Use <Text weight="semibold">this</Text></Text>`
 * does not emit invalid nested paragraphs. Use `as` to override when needed.
 *
 * Compose with `<Code>` for inline code and `<Link>` for hyperlinks inside
 * the text flow.
 *
 * @example
 * ```tsx
 * <Text>Primary body text.</Text>
 * <Text weight="semibold">Important note.</Text>
 * <Text italic tone="secondary">Supplementary remark.</Text>
 * <Text>Run <Code>npm install</Code> to get started.</Text>
 * <Text>See the <Link href="https://example.com">docs</Link> for details.</Text>
 * ```
 */
export declare function Text({ children, tone, size, as, weight, italic, truncate, style }: TextProps): JSX.Element;
export type H1Props = {
    children?: ReactNode;
    style?: CSSProperties;
};
/**
 * Page-level heading. Use once at the top of a canvas.
 * **Do not** place inside `CardHeader` — card headers use their own label.
 *
 * @example
 * ```tsx
 * <Stack>
 *   <H1>Performance Report</H1>
 *   <Card>…</Card>
 * </Stack>
 * ```
 */
export declare function H1({ children, style }: H1Props): JSX.Element;
export type H2Props = {
    children?: ReactNode;
    style?: CSSProperties;
};
/**
 * Section heading. Use between groups of cards or sections.
 * **Do not** place inside `CardHeader` — card headers use their own label.
 *
 * @example
 * ```tsx
 * <Stack>
 *   <H2>Recent activity</H2>
 *   <Card>…</Card>
 *   <Card>…</Card>
 * </Stack>
 * ```
 */
export declare function H2({ children, style }: H2Props): JSX.Element;
export type H3Props = {
    children?: ReactNode;
    style?: CSSProperties;
};
/**
 * Sub-section heading. Use below `H2` for finer hierarchy.
 *
 * @example
 * ```tsx
 * <Stack>
 *   <H2>API Reference</H2>
 *   <H3>Authentication</H3>
 *   <Text>All requests require a bearer token.</Text>
 * </Stack>
 * ```
 */
export declare function H3({ children, style }: H3Props): JSX.Element;
export type CodeProps = {
    children?: ReactNode;
    style?: CSSProperties;
};
/**
 * Inline `<code>` span for identifiers, file names, or short snippets.
 * Uses `0.92em` so it scales with surrounding text (headings, body, etc.).
 *
 * Prefer writing backtick markdown inside `Text` — e.g. `` <Text>Run `npm install`</Text> `` —
 * which is automatically parsed. Use `<Code>` only when you need an explicit element.
 *
 * @example
 * ```tsx
 * <Text>Run <Code>npm install</Code> to get started.</Text>
 * ```
 */
export declare function Code({ children, style }: CodeProps): JSX.Element;
export type LinkProps = {
    children?: ReactNode;
    href: string;
    style?: CSSProperties;
};
/**
 * Inline link that opens in the user's default browser.
 *
 * Prefer writing markdown links inside `Text` — e.g. `<Text>See the [docs](url)</Text>` —
 * which are automatically parsed. Use `<Link>` when you need an explicit anchor
 * outside of a text flow or when composing with other elements.
 *
 * @example
 * ```tsx
 * <Link href="https://docs.example.com">View documentation</Link>
 * ```
 */
export declare function Link({ children, href, style }: LinkProps): JSX.Element;
export type CardSize = "base" | "lg";
export type CardVariant = "default" | "borderless";
/**
 * Inline chevron SVG used by disclosure-style controls (collapsible cards,
 * expandable list items, etc.). Shared by `Card` and `todo-list.tsx` so
 * every disclosure in the canvas SDK uses the same glyph.
 */
export declare function CanvasChevron({ expanded }: {
    expanded: boolean;
}): JSX.Element;
export type CardProps = {
    children?: ReactNode;
    /** Default: bordered surface with radius; `borderless` removes both. */
    variant?: CardVariant;
    /** `lg` uses a taller header and roomier title padding (matches packages/ui). */
    size?: CardSize;
    /**
     * When true, the header uses `position: sticky` so it stays visible while
     * the card body scrolls. Requires the card (or a parent) to have a
     * constrained height and `overflow: auto` — the canvas host controls this,
     * so sticky behavior depends on the host viewport.
     */
    stickyHeader?: boolean;
    /**
     * Make the card collapsible. The header becomes a clickable toggle with
     * a leading chevron; `CardBody` renders nothing while the card is closed.
     */
    collapsible?: boolean;
    /** Initial open state in uncontrolled mode. Ignored when `open` is set. */
    defaultOpen?: boolean;
    /** Controlled open state. Pair with `onOpenChange`. */
    open?: boolean;
    /** Fires on every toggle with the next open state. */
    onOpenChange?: (open: boolean) => void;
    style?: CSSProperties;
};
/**
 * Bordered surface for a **labeled, self-contained unit** — a file, a service,
 * a config block, or a table with a title. Compose with `CardHeader` + `CardBody`.
 *
 * **When to use Card:**
 * - Displaying a named entity (file path, service name, resource).
 * - Wrapping a `<Table>` or `<DiffView>` that needs a title.
 * - A distinct, bounded section the user might scan by header label.
 *
 * **When NOT to use Card:**
 * - General text sections — use `<H2>` + `<Text>` instead. Not every section
 *   needs a border.
 * - Page-level layout — use `<Stack>` with headings. A canvas should not be a
 *   wall of stacked cards.
 * - Nesting — do not put cards inside cards. Use `<Divider>` within a card body.
 *
 * Pass **plain text** as `CardHeader` children — the header provides its own
 * 12px font. Do **not** put `<H1>` or `<H2>` inside a card header.
 *
 * Set `collapsible` to make the header a toggle that shows/hides `CardBody`.
 *
 * @example
 * ```tsx
 * // Card wraps a titled diff
 * <Card>
 *   <CardHeader trailing={<DiffStats additions={5} deletions={2} />}>
 *     src/utils.ts
 *   </CardHeader>
 *   <CardBody style={{ padding: 0 }}>
 *     <DiffView path="src/utils.ts" lines={lines} />
 *   </CardBody>
 * </Card>
 *
 * // Collapsible card
 * <Card collapsible defaultOpen={false}>
 *   <CardHeader>deploy-service.ts</CardHeader>
 *   <CardBody>Service handles rolling deployments across regions.</CardBody>
 * </Card>
 *
 * // Bad — card wrapping plain text that should just be a heading
 * // Use <H2>Overview</H2><Text>…</Text> instead.
 * ```
 */
export declare function Card({ children, variant, size, stickyHeader, collapsible, defaultOpen, open: openProp, onOpenChange, style }: CardProps): JSX.Element;
export type CardHeaderProps = {
    /** Plain text title. Do **not** pass headings, buttons, pills, or layout rows. */
    children?: ReactNode;
    /** Small trailing content aligned to the right edge — a status label, a
     *  single pill, or a short metadata string. Keep it compact. */
    trailing?: ReactNode;
    style?: CSSProperties;
};
/**
 * 28px header row (32px at `size="lg"`). A compact label for the card.
 *
 * **`children`** — plain text only. This is a 12px label, not a toolbar.
 * Do **not** pass `<H1>`, `<H2>`, `<Text weight="bold">`, `<Pill>`,
 * `<Button>`, `<Row>`, or any interactive/layout elements as children.
 *
 * **`trailing`** — optional right-aligned slot for small status indicators
 * (a short label, a single `<Pill>`, a metadata string like a timestamp).
 *
 * @example
 * ```tsx
 * // Good — plain title
 * <CardHeader>config.yaml</CardHeader>
 *
 * // Good — title with trailing status
 * <CardHeader trailing={<Pill active>Healthy</Pill>}>
 *   billing-service
 * </CardHeader>
 *
 * // Bad — heading in header (use CardHeader text, not H2)
 * // Bad — buttons in header (no room, wrong context)
 * // Bad — multiple pills in header (use trailing for one, or move to CardBody)
 * ```
 */
export declare function CardHeader({ children, trailing, style }: CardHeaderProps): JSX.Element;
export type CardBodyProps = {
    children?: ReactNode;
    style?: CSSProperties;
};
/**
 * Padded content area inside a Card.
 * Override `style` to adjust padding for custom layouts.
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>Overview</CardHeader>
 *   <CardBody>This service is currently healthy.</CardBody>
 * </Card>
 * ```
 */
export declare function CardBody({ children, style }: CardBodyProps): JSX.Element | null;
export type ButtonProps = {
    children?: ReactNode;
    variant?: "primary" | "secondary" | "ghost";
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    style?: CSSProperties;
    onClick?: () => void;
};
/**
 * Action button (24px height, sized to its label). **Never stretch to full
 * width** — buttons are always inline and hug their text.
 *
 * @example
 * ```tsx
 * <Row gap={8}>
 *   <Button variant="primary" onClick={handleSave}>Save</Button>
 *   <Button variant="secondary">Export</Button>
 *   <Button variant="ghost">Cancel</Button>
 * </Row>
 * ```
 */
export declare function Button({ children, variant, disabled, type, style, onClick }: ButtonProps): JSX.Element;
/** @deprecated Pills always render neutral now; tones are ignored. */
export type PillTone = "neutral" | "added" | "deleted" | "renamed" | "success" | "warning" | "info";
export type PillSize = "sm" | "md";
export type PillProps = {
    children?: ReactNode;
    /** Whether the pill is in its selected/active state (filled background). */
    active?: boolean;
    /** @deprecated Ignored — pills always render with neutral styling. */
    tone?: PillTone;
    /**
     * Visual size. `"md"` (default) is the standard pill. `"sm"` is a
     * compact variant with smaller text, tighter padding, and no border —
     * designed for tight spaces like `CardHeader` trailing slots.
     */
    size?: PillSize;
    /** Shown before the label (icon, emoji, etc.). */
    leadingContent?: ReactNode;
    /** e.g. shortcut hint — matches ui `Pill` ghost keyboard hint (muted primary). */
    keyboardHint?: string;
    disabled?: boolean;
    title?: string;
    style?: CSSProperties;
    onClick?: () => void;
};
/**
 * Pill-shaped label or toggle button. Use for tab bars, filter groups, or
 * action suggestions. Set `active` for the selected state (filled background).
 *
 * @example
 * ```tsx
 * // Tab-style selector
 * <Row gap={8}>
 *   {tabs.map(tab => (
 *     <Pill key={tab} active={tab === selected} onClick={() => setSelected(tab)}>
 *       {tab}
 *     </Pill>
 *   ))}
 * </Row>
 *
 * // Action suggestion with shortcut hint
 * <Pill onClick={handlePlan} keyboardHint="⇧Tab">Plan new idea</Pill>
 * ```
 */
export declare function Pill({ children, active, size, leadingContent, keyboardHint, disabled, title, style, onClick }: PillProps): JSX.Element;
export type StatTone = "success" | "danger" | "warning" | "info";
export type StatProps = {
    /** The primary metric value (number, percentage, short string). */
    value: ReactNode;
    /** Label below the value. */
    label: string;
    /** Semantic color for the value. Omit for default primary text. */
    tone?: StatTone;
    style?: CSSProperties;
};
/**
 * Single metric display — a large value with a compact label beneath it.
 * Use inside `<Grid>` for dashboard summary strips.
 *
 * @example
 * ```tsx
 * <Grid columns={3} gap={16}>
 *   <Stat value="4" label="Healthy" tone="success" />
 *   <Stat value="1" label="Degraded" tone="warning" />
 *   <Stat value="99.2%" label="Avg Uptime" />
 * </Grid>
 * ```
 */
export declare function Stat({ value, label, tone, style }: StatProps): JSX.Element;
export type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral";
export type CalloutProps = {
    /** Body content. Plain strings, `<Text>`, `<Code>`, `<Link>`, or short lists. */
    children?: ReactNode;
    /** Semantic tone. Selects a default leading icon when `icon` is omitted. */
    tone?: CalloutTone;
    /** Optional bold title line, shown above the body. */
    title?: ReactNode;
    /** Optional leading icon (emoji, inline SVG, or short text glyph). */
    icon?: ReactNode;
    style?: CSSProperties;
};
/**
 * Inline notice for warnings, tips, or short status messages. Each `tone`
 * renders a cursor icon matching `@anysphere/ui` toasts (override with `icon`).
 *
 * @example
 * ```tsx
 * <Callout tone="warning" title="Heads up">
 *   Rolling deploy is in progress. Metrics may be noisy for 10 minutes.
 * </Callout>
 * ```
 */
export declare function Callout({ children, tone, title, icon, style }: CalloutProps): JSX.Element;
//# sourceMappingURL=ui-primitives.d.ts.map