/**
 * Colored category swatch — a small filled rounded box. Intended for inline
 * list/row decoration (category badges, the leading slot of
 * `CollapsibleSection`, etc.).
 *
 * Pulls colors from `useHostTheme().category` so a category's swatch and its
 * `UsageBar` segment for the same `color` stay visually coherent.
 */
import type { CSSProperties, JSX } from "react";
import type { Color } from "./canvas-tokens.js";
export type SwatchProps = {
    /** One of the 7 shared category hues. Matches `UsageBar` segment colors. */
    color: Color;
    style?: CSSProperties;
};
/**
 * Filled, rounded category swatch (24px). Use as the leading visual on
 * category rows, list items, or as the `leading` slot of a
 * `CollapsibleSection`.
 *
 * Colors come from the shared 7-hue `Color` palette, so a category's swatch
 * matches its `UsageBar` segment for the same `color`.
 *
 * @example
 * ```tsx
 * // Standalone — purple "tools" swatch
 * <Swatch color="purple" />
 *
 * // As the `leading` slot on a CollapsibleSection
 * <CollapsibleSection
 *   title="Tools"
 *   count={4}
 *   leading={<Swatch color="purple" />}
 * >
 *   <Text>Tool calls go here.</Text>
 * </CollapsibleSection>
 * ```
 */
export declare function Swatch({ color, style }: SwatchProps): JSX.Element;
//# sourceMappingURL=swatch.d.ts.map