export { default as manifest } from "./manifest.js";
export { default as worker } from "./worker.js";
export {
  MOBILE_VIEWPORT_GUARD_META_CONTENT,
  MOBILE_VIEWPORT_GUARD_STYLE_ID,
  MOBILE_VIEWPORT_GUARD_META_MARKER,
  MOBILE_DROPDOWN_INPUT_GUARD_MARKER,
  MOBILE_DROPDOWN_INPUT_SELECTOR,
  isGuardedMobileViewport,
  shouldGuardDropdownKeyboard,
  mobileViewportGuardCss,
} from "./mobile-viewport-guard.js";
