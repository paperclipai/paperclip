export const MOBILE_VIEWPORT_GUARD_META_CONTENT =
  "width=device-width, initial-scale=1, viewport-fit=cover";
export const MOBILE_VIEWPORT_GUARD_STYLE_ID = "paperclip-mobile-viewport-guard-style";
export const MOBILE_VIEWPORT_GUARD_META_MARKER = "data-paperclip-mobile-viewport-guard";
export const MOBILE_DROPDOWN_INPUT_GUARD_MARKER = "data-paperclip-mobile-dropdown-keyboard-guard";

export const MOBILE_DROPDOWN_INPUT_SELECTOR = [
  "[data-radix-popper-content-wrapper] input",
  "[data-radix-select-content] input",
  "[role=\"listbox\"] input",
  "[role=\"dialog\"] input[cmdk-input]",
  "[cmdk-root] input",
  "[data-paperclip-mobile-dropdown-keyboard-guard-scope] input",
].join(", ");

export function isGuardedMobileViewport(width: number, pointerIsCoarse = false): boolean {
  return (Number.isFinite(width) && width <= 820) || pointerIsCoarse;
}

function currentPointerIsCoarse(): boolean {
  return globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export function shouldGuardDropdownKeyboard(
  input: Element,
  viewportWidth = globalThis.innerWidth,
  pointerIsCoarse = currentPointerIsCoarse(),
): input is HTMLInputElement {
  if (!(input instanceof HTMLInputElement)) return false;
  if (!isGuardedMobileViewport(viewportWidth, pointerIsCoarse)) return false;
  return input.matches(MOBILE_DROPDOWN_INPUT_SELECTOR);
}

export function mobileViewportGuardCss(): string {
  return `
@media (max-width: 820px), (pointer: coarse) {
  html,
  body,
  #root {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: clip;
    overscroll-behavior-x: none;
    touch-action: pan-y pinch-zoom;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  body {
    position: relative;
  }

  input,
  textarea,
  select,
  button,
  [role="button"],
  [role="combobox"],
  [role="listbox"],
  [data-radix-select-trigger],
  [cmdk-input],
  .select-trigger,
  .combobox-trigger {
    font-size: max(16px, 1em) !important;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  input,
  textarea,
  select {
    transform: translateZ(0);
  }

  input[${MOBILE_DROPDOWN_INPUT_GUARD_MARKER}="true"] {
    caret-color: transparent !important;
    -webkit-user-select: none;
    user-select: none;
  }

  [data-radix-popper-content-wrapper],
  [data-radix-select-content],
  [role="listbox"] {
    max-width: min(96vw, 560px) !important;
  }
}
`.trim();
}
