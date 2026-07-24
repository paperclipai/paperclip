export const CHROMELESS_DISPLAY_MODES = ["standalone", "fullscreen", "window-controls-overlay"] as const;

type DisplayMode = (typeof CHROMELESS_DISPLAY_MODES)[number];
type MatchDisplayMode = (query: string) => Pick<MediaQueryList, "matches">;

function displayModeQuery(mode: DisplayMode) {
  return `(display-mode: ${mode})`;
}

function defaultMatchMedia(): MatchDisplayMode | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return window.matchMedia.bind(window);
}

export function isChromelessDisplayMode(
  matchMedia: MatchDisplayMode | undefined = defaultMatchMedia(),
  iosStandalone: boolean | undefined =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { standalone?: boolean }).standalone,
) {
  if (iosStandalone === true) return true;
  if (!matchMedia) return false;

  return CHROMELESS_DISPLAY_MODES.some((mode) => matchMedia(displayModeQuery(mode)).matches);
}
