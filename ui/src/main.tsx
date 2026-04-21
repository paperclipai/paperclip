import * as React from "react";
import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { CompanyProvider } from "./context/CompanyContext";
import { LiveUpdatesProvider } from "./context/LiveUpdatesProvider";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { PanelProvider } from "./context/PanelContext";
import { SidebarProvider } from "./context/SidebarContext";
import { DialogProvider } from "./context/DialogContext";
import { EditorAutocompleteProvider } from "./context/EditorAutocompleteContext";
import { ToastProvider } from "./context/ToastContext";
import { ThemeProvider } from "./context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initPluginBridge } from "./plugins/bridge-init";
import { PluginLauncherProvider } from "./plugins/launchers";
import "@mdxeditor/editor/style.css";
import "./index.css";

initPluginBridge(React, ReactDOM);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <CompanyProvider>
            <EditorAutocompleteProvider>
              <ToastProvider>
                <LiveUpdatesProvider>
                  <TooltipProvider>
                    <BreadcrumbProvider>
                      <SidebarProvider>
                        <PanelProvider>
                          <PluginLauncherProvider>
                            <DialogProvider>
                              <App />
                            </DialogProvider>
                          </PluginLauncherProvider>
                        </PanelProvider>
                      </SidebarProvider>
                    </BreadcrumbProvider>
                  </TooltipProvider>
                </LiveUpdatesProvider>
              </ToastProvider>
            </EditorAutocompleteProvider>
          </CompanyProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
