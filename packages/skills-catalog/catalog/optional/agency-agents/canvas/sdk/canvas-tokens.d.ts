/**
 * Design tokens for `cursor/canvas` (standalone; no UI framework dependency).
 *
 * Color values are aligned with the Cursor app dark theme (`packages/ui` `cursor-dark` sources).
 */
export declare const canvasPaletteDark: {
    readonly foreground: "#E4E4E4EB";
    readonly foregroundSecondary: "#E4E4E48D";
    readonly foregroundTertiary: "#E4E4E45E";
    readonly foregroundQuaternary: "#E4E4E442";
    readonly editor: "#181818";
    readonly chrome: "#141414";
    readonly sidebar: "#141414";
    readonly elevated: "#181818";
    readonly fillPrimary: "#E4E4E430";
    readonly fillSecondary: "#E4E4E41E";
    readonly fillTertiary: "#E4E4E411";
    readonly fillQuaternary: "#E4E4E40A";
    readonly strokePrimary: "#E4E4E433";
    readonly strokeSecondary: "#E4E4E41F";
    readonly strokeTertiary: "#E4E4E414";
    readonly strokeFocused: "#E4E4E4";
    readonly accent: "#599CE7";
    readonly buttonBackground: "#599CE7";
    readonly buttonForeground: "#191c22";
    readonly buttonHoverBackground: "#6AABE9";
    readonly link: "#87c3ff";
    readonly diffInsertedLine: "#3FA26633";
    readonly diffRemovedLine: "#B8004933";
    readonly diffStripAdded: "#3FA2668F";
    readonly diffStripRemoved: "#FC6B838F";
};
/**
 * Light-mode palette derived from `packages/ui/src/tokens/themes/cursor-core/light.ts`.
 * Base color: #141414.  Same percentages as dark (regular light has no overrides
 * in CURSOR_SEMANTIC_OVERRIDES — only high-contrast does).
 */
export declare const canvasPaletteLight: {
    readonly foreground: "#141414F0";
    readonly foregroundSecondary: "#141414BD";
    readonly foregroundTertiary: "#1414148A";
    readonly foregroundQuaternary: "#1414145C";
    readonly editor: "#FCFCFC";
    readonly chrome: "#F8F8F8";
    readonly sidebar: "#F3F3F3";
    readonly elevated: "#FCFCFC";
    readonly fillPrimary: "#14141433";
    readonly fillSecondary: "#14141424";
    readonly fillTertiary: "#14141414";
    readonly fillQuaternary: "#1414140F";
    readonly strokePrimary: "#14141433";
    readonly strokeSecondary: "#1414141F";
    readonly strokeTertiary: "#14141414";
    readonly strokeFocused: "#3685BF";
    readonly accent: "#3685BF";
    readonly buttonBackground: "#3685BF";
    readonly buttonForeground: "#FCFCFC";
    readonly buttonHoverBackground: "#2E76AB";
    readonly link: "#3685BF";
    readonly diffInsertedLine: "#1F8A651F";
    readonly diffRemovedLine: "#CF2D5614";
    readonly diffStripAdded: "#1F8A65CC";
    readonly diffStripRemoved: "#CF2D56CC";
};
export interface CanvasPalette {
    readonly foreground: string;
    readonly foregroundSecondary: string;
    readonly foregroundTertiary: string;
    readonly foregroundQuaternary: string;
    readonly editor: string;
    readonly chrome: string;
    readonly sidebar: string;
    readonly elevated: string;
    readonly fillPrimary: string;
    readonly fillSecondary: string;
    readonly fillTertiary: string;
    readonly fillQuaternary: string;
    readonly strokePrimary: string;
    readonly strokeSecondary: string;
    readonly strokeTertiary: string;
    readonly strokeFocused: string;
    readonly accent: string;
    readonly buttonBackground: string;
    readonly buttonForeground: string;
    readonly buttonHoverBackground: string;
    readonly link: string;
    readonly diffInsertedLine: string;
    readonly diffRemovedLine: string;
    readonly diffStripAdded: string;
    readonly diffStripRemoved: string;
}
/**
 * Chart color palette — distilled from portal-website analytics charts.
 * 88% opacity (E0) softens vibrancy without dulling; palette maximizes
 * hue + luminosity spread for distinguishable multi-series charts.
 */
export declare const chartPalette: {
    readonly green: "#1F8A65E8";
    readonly darkGreen: "#0D855AE0";
    readonly lightGreen: "#52B896E0";
    readonly mintGreen: "#7DCAB0E0";
    readonly blue: "#2E79B5E0";
    readonly lightBlue: "#70B0D8E0";
    readonly indigo: "#5A6CC0F0";
    readonly lightIndigo: "#9AAADCE0";
    readonly purple: "#7B64B8F0";
    readonly lightPurple: "#AA98D8E0";
    readonly warmPink: "#C85898E0";
    readonly lightPink: "#E8A0C4E0";
    readonly brightOrange: "#F0A040E0";
    readonly deepOrange: "#C06028E0";
    readonly goldenYellow: "#E8C030E0";
    readonly darkAmber: "#C04848E0";
    readonly warmPeach: "#F0A088E0";
    readonly vibrantTeal: "#2A9A8AE0";
    readonly muted: "#8888A8E0";
    readonly neutralLine: "#888899D0";
};
/**
 * Shared category palette for canvas primitives that show categorical tints
 * (`Swatch`, `UsageBar` segments, etc.). Hexes mirror the cursor core hues
 * from `packages/ui/src/tokens/themes/cursor-core/{dark,light}.ts` (via the
 * `text-{hue}-primary` semantic tokens); `gray` mirrors `text-tertiary`
 * (`mixTransparent base 54%`).
 *
 * The insertion order here is the canonical category order — primitives
 * that auto-assign colors (e.g. `UsageBar` segments without an explicit
 * `color`) cycle through these keys in order.
 */
export declare const categoryPaletteDark: {
    readonly gray: "#E4E4E48A";
    readonly purple: "#9386F2";
    readonly green: "#3FA266";
    readonly yellow: "#F1B467";
    readonly pink: "#B48EAD";
    readonly blue: "#7BAFE9";
    readonly orange: "#D08770";
};
export declare const categoryPaletteLight: {
    readonly gray: "#1414148A";
    readonly purple: "#7754D9";
    readonly green: "#1F8A65";
    readonly yellow: "#C08532";
    readonly pink: "#B8448B";
    readonly blue: "#3685BF";
    readonly orange: "#DB704B";
};
/** Legacy `colorPalette` name kept for back-compat; per-theme tables are `categoryPalette{Dark,Light}`. React consumers should read `useHostTheme().category` so the color flips with the host theme. */
export declare const colorPalette: {
    readonly gray: "#E4E4E48A";
    readonly purple: "#9386F2";
    readonly green: "#3FA266";
    readonly yellow: "#F1B467";
    readonly pink: "#B48EAD";
    readonly blue: "#7BAFE9";
    readonly orange: "#D08770";
};
export type Color = keyof typeof colorPalette;
export type CategoryPalette = Readonly<Record<Color, string>>;
/**
 * Auto-color rotation for `UsageBar` segments without an explicit `color`.
 * Decoupled from `colorPalette`'s declaration order so the palette can grow
 * or be reordered without changing how unspecified segments cycle.
 *
 * Matches the original `packages/ui` `ContextUsageTray` order so the same
 * segment index lands on the same hue as the source.
 */
export declare const usageColorSequence: readonly Color[];
/**
 * Ordered array for automatic series coloring — alternates dark/light across
 * distinct hue families for maximum perceptual separation.
 */
export declare const chartColorSequence: readonly ["#1F8A65E8", "#70B0D8E0", "#5A6CC0F0", "#F0A040E0", "#C06028E0", "#E8C030E0", "#C85898E0", "#F0A088E0", "#7B64B8F0", "#7DCAB0E0", "#8888A8E0", "#2A9A8AE0"];
declare function buildTokens(palette: CanvasPalette, category: CategoryPalette): {
    bg: {
        editor: string;
        chrome: string;
        elevated: string;
    };
    text: {
        primary: string;
        secondary: string;
        tertiary: string;
        quaternary: string;
        link: string;
        onAccent: string;
    };
    stroke: {
        primary: string;
        secondary: string;
        tertiary: string;
        focused: string;
    };
    fill: {
        primary: string;
        secondary: string;
        tertiary: string;
        quaternary: string;
    };
    accent: {
        primary: string;
        control: string;
        controlHover: string;
    };
    diff: {
        insertedLine: string;
        removedLine: string;
        stripAdded: string;
        stripRemoved: string;
    };
    category: Readonly<Record<"blue" | "gray" | "green" | "orange" | "pink" | "purple" | "yellow", string>>;
};
/** Semantic colors for components (spacing and radius live in `theme.ts`). */
export declare const canvasTokens: {
    bg: {
        editor: string;
        chrome: string;
        elevated: string;
    };
    text: {
        primary: string;
        secondary: string;
        tertiary: string;
        quaternary: string;
        link: string;
        onAccent: string;
    };
    stroke: {
        primary: string;
        secondary: string;
        tertiary: string;
        focused: string;
    };
    fill: {
        primary: string;
        secondary: string;
        tertiary: string;
        quaternary: string;
    };
    accent: {
        primary: string;
        control: string;
        controlHover: string;
    };
    diff: {
        insertedLine: string;
        removedLine: string;
        stripAdded: string;
        stripRemoved: string;
    };
    category: Readonly<Record<"blue" | "gray" | "green" | "orange" | "pink" | "purple" | "yellow", string>>;
};
export declare const canvasTokensLight: {
    bg: {
        editor: string;
        chrome: string;
        elevated: string;
    };
    text: {
        primary: string;
        secondary: string;
        tertiary: string;
        quaternary: string;
        link: string;
        onAccent: string;
    };
    stroke: {
        primary: string;
        secondary: string;
        tertiary: string;
        focused: string;
    };
    fill: {
        primary: string;
        secondary: string;
        tertiary: string;
        quaternary: string;
    };
    accent: {
        primary: string;
        control: string;
        controlHover: string;
    };
    diff: {
        insertedLine: string;
        removedLine: string;
        stripAdded: string;
        stripRemoved: string;
    };
    category: Readonly<Record<"blue" | "gray" | "green" | "orange" | "pink" | "purple" | "yellow", string>>;
};
export type CanvasTokens = ReturnType<typeof buildTokens>;
export {};
//# sourceMappingURL=canvas-tokens.d.ts.map