export type { CanvasPalette, CanvasTokens } from "./canvas-tokens.js";
export { canvasPaletteDark, canvasPaletteLight, canvasTokens, canvasTokensLight, } from "./canvas-tokens.js";
/** Typography presets used by the built-in `cursor/canvas` components. */
export declare const canvasTypography: {
    readonly h1: {
        readonly fontSize: "24px";
        readonly lineHeight: "30px";
        readonly fontWeight: 590;
    };
    readonly h2: {
        readonly fontSize: "18px";
        readonly lineHeight: "24px";
        readonly fontWeight: 590;
    };
    readonly h3: {
        readonly fontSize: "16px";
        readonly lineHeight: "22px";
        readonly fontWeight: 590;
    };
    readonly body: {
        readonly fontSize: "14px";
        readonly lineHeight: "20px";
        readonly fontWeight: 400;
    };
    readonly small: {
        readonly fontSize: "12px";
        readonly lineHeight: "16px";
        readonly fontWeight: 400;
    };
};
/** Spacing scale (px). */
export declare const canvasSpacing: {
    readonly "0.5": 2;
    readonly "1": 4;
    readonly "1.5": 6;
    readonly "2": 8;
    readonly "2.5": 10;
    readonly "3": 12;
    readonly "3.5": 14;
    readonly "4": 16;
    readonly "4.5": 18;
    readonly "5": 20;
    readonly "6": 24;
    readonly "7": 28;
    readonly "8": 32;
    readonly "9": 36;
    readonly "10": 40;
};
export type CanvasSpacing = typeof canvasSpacing;
/** Border radius (px). */
export declare const canvasRadius: {
    readonly none: 0;
    readonly xs: 2;
    readonly sm: 4;
    readonly md: 6;
    readonly lg: 8;
    readonly xl: 12;
    readonly full: 9999;
};
export type CanvasRadius = typeof canvasRadius;
//# sourceMappingURL=theme.d.ts.map