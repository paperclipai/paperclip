/**
 * Borderless disclosure row — chevron + structured header (title, optional
 * leading slot, count, trailing slot) with a body that toggles open. Distilled
 * from baby-glass `ContextTreeRow`'s lightweight list-row chrome (no card
 * border, no background fill).
 *
 * For a bordered surface that collapses, use `<Card collapsible>` instead.
 */
import { type CSSProperties, type JSX, type ReactNode } from "react";
export type CollapsibleSectionProps = {
    /** Plain-text title rendered next to the disclosure chevron. */
    title: string;
    /**
     * Optional leading visual (e.g. `<Swatch>`) shown between the chevron and
     * the title.
     */
    leading?: ReactNode;
    /**
     * Optional small count rendered after the title (e.g. number of children).
     */
    count?: number;
    /**
     * Optional trailing node, right-aligned (e.g. token readout, badge, button).
     * Rendered with `t.text.tertiary` color hint via the wrapper; the slot can
     * override.
     */
    trailing?: ReactNode;
    /** Body shown when expanded. */
    children?: ReactNode;
    /** When true, the section starts expanded (uncontrolled). */
    defaultOpen?: boolean;
    style?: CSSProperties;
};
/**
 * Borderless collapsible row with a structured header. Starts closed unless
 * `defaultOpen` is set.
 *
 * Compose with `<Swatch>` in the `leading` slot for a colored category icon,
 * and put a token readout / pill / button in `trailing`. Body content is
 * indented under the row so nested `CollapsibleSection`s read as a tree.
 *
 * For a bordered, card-shaped collapsible surface, use `<Card collapsible>`
 * instead — `CollapsibleSection` has no border or background and is meant to
 * sit in a list of similar rows.
 *
 * @example
 * ```tsx
 * // Basic
 * <CollapsibleSection title="Conversation">
 *   <Text>Messages go here.</Text>
 * </CollapsibleSection>
 *
 * // With a colored category swatch + count + trailing token readout
 * <CollapsibleSection
 *   title="Tools"
 *   count={4}
 *   leading={<Swatch color="purple" />}
 *   trailing={<Text size="small" tone="tertiary">12.3k</Text>}
 * >
 *   <CollapsibleSection title="Grep">
 *     <Text>Search results.</Text>
 *   </CollapsibleSection>
 * </CollapsibleSection>
 * ```
 */
export declare function CollapsibleSection({ title, leading, count, trailing, children, defaultOpen, style }: CollapsibleSectionProps): JSX.Element;
//# sourceMappingURL=collapsible-section.d.ts.map