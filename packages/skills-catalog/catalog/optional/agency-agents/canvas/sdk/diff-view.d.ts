/**
 * Low-level diff primitives for the canvas SDK.
 *
 * The canvas diff surface is intentionally minimal — two components that
 * compose with the generic `Card` / `CardHeader` / `CardBody` / `Pill` /
 * `Text` primitives to build any diff layout an agent can imagine:
 *
 * - `DiffView` — a monospaced, syntax-highlighted unified diff renderer.
 *   Drops into any container (a `Card`, a table cell, a bare layout,
 *   nothing at all). No card chrome, no header, no path display. Pass
 *   `path` to auto-detect the language for highlighting, or `language`
 *   to override.
 *
 * - `DiffStats` — the canonical `+N` green / `-N` red glyph pair. Use
 *   it anywhere a small "added/deleted" summary makes sense — in a
 *   `CardHeader`'s `trailing` slot, next to a filename in a file tree,
 *   inside a status row, etc.
 *
 * For file-level metadata the preferred composition is to use the
 * generic `Card` family:
 *
 * ```tsx
 * <Card collapsible>
 *   <CardHeader trailing={<DiffStats additions={5} deletions={2} />}>
 *     src/utils.ts
 *   </CardHeader>
 *   <CardBody style={{ padding: 0 }}>
 *     <DiffView path="src/utils.ts" lines={lines} />
 *   </CardBody>
 * </Card>
 * ```
 */
import type { CSSProperties, JSX } from "react";
export type DiffStatsProps = {
    additions?: number;
    deletions?: number;
    style?: CSSProperties;
};
/**
 * Inline `+N` / `-N` glyph pair. Green additions, red deletions, with
 * tabular numerals so columns of stats line up. Renders nothing when
 * both counts are zero.
 *
 * @example
 * ```tsx
 * <CardHeader trailing={<DiffStats additions={12} deletions={3} />}>
 *   src/utils.ts
 * </CardHeader>
 *
 * <Row gap={8}>
 *   <Text>Refactor pass</Text>
 *   <DiffStats additions={42} deletions={17} />
 * </Row>
 * ```
 */
export declare function DiffStats({ additions, deletions, style }: DiffStatsProps): JSX.Element | null;
export type DiffLineType = "added" | "removed" | "unchanged";
export type DiffLineData = {
    type: DiffLineType;
    content: string;
    lineNumber?: number;
};
export type DiffViewProps = {
    lines: DiffLineData[];
    /**
     * File path used to infer the syntax-highlighting language from the
     * extension (e.g. `"src/utils.ts"` → `typescript`). The most ergonomic
     * way to enable highlighting — pass the same path you show in the
     * enclosing card header. Unknown extensions silently render as plain
     * text.
     *
     * If both `path` and `language` are provided, `language` wins.
     */
    path?: string;
    /**
     * Explicit language override for syntax highlighting (e.g.
     * `"typescript"`, `"python"`, `"tsx"`). Use this when no file path is
     * available, when the path's extension is misleading, or when the
     * content is a snippet rather than a real file. Accepts common
     * aliases (`ts`, `py`, `rs`, `md`, etc.). Unknown languages silently
     * fall back to plain text.
     *
     * Highlighting is applied per line, so multi-line constructs (block
     * comments, template literals) may not colorize perfectly across line
     * boundaries. For typical diff-sized inputs this is fine.
     */
    language?: string;
    /** Show line numbers in the gutter. Default `true`. */
    showLineNumbers?: boolean;
    /** Color line numbers green/red for added/removed lines. Default `true`. */
    coloredLineNumbers?: boolean;
    /** Show a 3px accent strip on the left edge for changed lines. Default `true`. */
    showAccentStrip?: boolean;
    style?: CSSProperties;
};
/**
 * Unified diff body renderer with monospaced type, colored line
 * backgrounds, line-number gutter, accent strip, and optional Shiki
 * syntax highlighting.
 *
 * `DiffView` does not provide any surrounding chrome — place it inside
 * a `Card` + `CardBody` (with `padding: 0`) when you want the standard
 * bordered "file diff" look, or drop it anywhere else if you want the
 * bare renderer.
 *
 * Pass `path` to enable syntax highlighting from the file extension.
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader trailing={<DiffStats additions={2} deletions={1} />}>
 *     src/utils.ts
 *   </CardHeader>
 *   <CardBody style={{ padding: 0 }}>
 *     <DiffView
 *       path="src/utils.ts"
 *       lines={[
 *         { type: "unchanged", content: "export function add(a: number, b: number): number {", lineNumber: 1 },
 *         { type: "removed",   content: "  return a + b;", lineNumber: 2 },
 *         { type: "added",     content: "  const result = a + b;", lineNumber: 2 },
 *         { type: "added",     content: "  return result;", lineNumber: 3 },
 *         { type: "unchanged", content: "}", lineNumber: 4 },
 *       ]}
 *     />
 *   </CardBody>
 * </Card>
 * ```
 */
export declare function DiffView({ lines, path, language, showLineNumbers, coloredLineNumbers, showAccentStrip, style }: DiffViewProps): JSX.Element;
//# sourceMappingURL=diff-view.d.ts.map