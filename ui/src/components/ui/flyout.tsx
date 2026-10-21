import { forwardRef, type ComponentProps, type CSSProperties } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { FlyoutAppearanceProvider } from "./flyout-appearance";
import { cn } from "@/lib/utils";

export { FlyoutAppearanceProvider, useFlyoutAppearance, type FlyoutAppearance } from "./flyout-appearance";

/** Proposed popover composition. Dropdowns reuse the same header, options and
 * appearance provider while retaining their menu-specific keyboard behavior. */
export function Flyout(props: ComponentProps<typeof Popover>) {
  return <FlyoutAppearanceProvider><Popover {...props} /></FlyoutAppearanceProvider>;
}

export const FlyoutTrigger = PopoverTrigger;

export function FlyoutContent({ className, style, shadow, ...props }: ComponentProps<typeof PopoverContent> & { shadow?: CSSProperties["boxShadow"] }) {
  return <PopoverContent className={cn("w-(--flyout-width)", className)} style={{ ...style, ...(shadow ? { "--shadow-flyout": shadow } : {}) } as CSSProperties} {...props} />;
}

export const FlyoutHeader = forwardRef<HTMLDivElement, ComponentProps<"div">>(function FlyoutHeader(props, ref) {
  return <div ref={ref} data-flyout-header {...props} />;
});

export const FlyoutOptions = forwardRef<HTMLDivElement, ComponentProps<"div">>(function FlyoutOptions(props, ref) {
  return <div ref={ref} data-flyout-options {...props} />;
});
