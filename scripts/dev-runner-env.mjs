const DEFAULT_UI_DEV_MIDDLEWARE = "true";

// The dev runner used to hardcode this value, which silently discarded an
// operator's explicit setting (e.g. a launchd/systemd unit exporting
// PAPERCLIP_UI_DEV_MIDDLEWARE=false to serve a built ui/dist instead of Vite
// dev middleware). Default instead of override so an explicit value wins.
export function resolveUiDevMiddlewareEnv(sourceEnv) {
  return sourceEnv.PAPERCLIP_UI_DEV_MIDDLEWARE ?? DEFAULT_UI_DEV_MIDDLEWARE;
}
