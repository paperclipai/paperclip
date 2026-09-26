import type { JSX } from "react";
type CalloutToneIconGlyph = "info" | "warning" | "circles-check" | "exclamation-circle";
type CalloutToneForIcon = "info" | "success" | "warning" | "danger" | "neutral";
/** Maps `Callout` tone to the same cursor icons used by `@anysphere/ui` toasts. */
export declare const calloutToneIconGlyph: Record<Exclude<CalloutToneForIcon, "neutral">, CalloutToneIconGlyph>;
export declare function CalloutToneIcon({ tone, color }: {
    tone: CalloutToneForIcon;
    color: string;
}): JSX.Element;
export {};
//# sourceMappingURL=callout-tone-icons.d.ts.map