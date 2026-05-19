// LET-461 / LET-463 — EAOS product route detector used by the kernel
// `Layout` to decide whether to suppress the legacy Paperclip board sidebar,
// breadcrumb, account menu, and mobile bottom nav around the EaosShell.
//
// EAOS routes are mounted under `/<companyPrefix>/eaos[/...]` per App.tsx.
// Kept in its own tiny module so route-gate tests do not have to import the
// full `Layout` (which transitively pulls in Stitches / Sandpack / plugin
// chrome that throws in jsdom).

export function isEaosProductRoute(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return segments[1]?.toLowerCase() === "eaos";
}
