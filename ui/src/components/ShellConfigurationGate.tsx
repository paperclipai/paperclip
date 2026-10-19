import { Outlet } from "@/lib/router";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

/** Keep shell selection stable while the independent access gate loads. */
export function ShellConfigurationGate({ loaded }: { loaded: boolean }) {
  return loaded ? <Outlet /> : <PaperclipLoading />;
}
