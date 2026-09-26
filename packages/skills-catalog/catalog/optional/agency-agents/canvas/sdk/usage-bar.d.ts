/**
 * Segmented usage bar primitive — proportional pills + remainder, with an
 * optional one-line label row above. Visually matches `packages/ui`
 * `ContextUsageTray`'s usage bar, themed for canvas via the shared `Color`
 * palette and `useHostTheme()` semantic tokens.
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import { type Color } from "./canvas-tokens.js";
export interface UsageBarSegment {
    /** Stable identifier (used as React key). */
    readonly id: string;
    /** Proportional weight for this segment. Non-finite or `<= 0` is treated as 0. */
    readonly value: number;
    /**
     * Optional explicit color. Defaults to a rotation through
     * `usageColorSequence` by index, matching the original `packages/ui`
     * `ContextUsageTray` order so the same index lands on the same hue.
     */
    readonly color?: Color;
}
export type UsageBarProps = {
    /** Segments rendered left-to-right; widths are proportional to `value`. */
    readonly segments: readonly UsageBarSegment[];
    /** Total weight of the bar. The remainder span fills `max(0, total - sum(values))`. */
    readonly total: number;
    /** Optional small label rendered above the bar, left-aligned. */
    readonly topLeftLabel?: ReactNode;
    /** Optional small label rendered above the bar, right-aligned. */
    readonly topRightLabel?: ReactNode;
    readonly style?: CSSProperties;
};
/**
 * Segmented horizontal usage bar — proportional category pills with a
 * remainder span. Use to visualize a fixed-budget breakdown (context window
 * tokens, storage usage, etc.).
 *
 * @example
 * ```tsx
 * <UsageBar
 *   total={120_000}
 *   topLeftLabel="64% Full"
 *   topRightLabel="76.8K / 120K Tokens"
 *   segments={[
 *     { id: "system", value: 8_000, color: "gray" },
 *     { id: "tools", value: 24_000, color: "purple" },
 *     { id: "rules", value: 12_000, color: "green" },
 *     { id: "skills", value: 6_000, color: "yellow" },
 *     { id: "mcp", value: 4_000, color: "pink" },
 *     { id: "subagents", value: 8_800, color: "blue" },
 *     { id: "conversation", value: 14_000, color: "orange" },
 *   ]}
 * />
 * ```
 */
export declare function UsageBar({ segments, total, topLeftLabel, topRightLabel, style }: UsageBarProps): JSX.Element;
//# sourceMappingURL=usage-bar.d.ts.map