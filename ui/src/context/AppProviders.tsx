import type { ReactNode } from "react";
import { BrowserRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyProvider } from "./CompanyContext";
import { LiveUpdatesProvider } from "./LiveUpdatesProvider";
import { SidebarProvider } from "./SidebarContext";
import { PanelProvider } from "./PanelContext";
import { DialogProvider } from "./DialogContext";
import { ToastProvider } from "./ToastContext";
import { ThemeProvider } from "./ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginLauncherProvider } from "../plugins/launchers";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <CompanyProvider>
            <ToastProvider>
              <LiveUpdatesProvider>
                <TooltipProvider>
                  <SidebarProvider>
                    <PanelProvider>
                      <PluginLauncherProvider>
                        <DialogProvider>
                          {children}
                        </DialogProvider>
                      </PluginLauncherProvider>
                    </PanelProvider>
                  </SidebarProvider>
                </TooltipProvider>
              </LiveUpdatesProvider>
            </ToastProvider>
          </CompanyProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
