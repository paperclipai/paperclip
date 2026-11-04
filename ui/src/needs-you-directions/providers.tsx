import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyProvider } from "@/context/CompanyContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { DialogProvider } from "@/context/DialogContext";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { PanelProvider } from "@/context/PanelContext";
import { TooltipProvider } from "@/components/ui/tooltip";

export function createLabQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
}

export function LabProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <CompanyProvider>
            <ToastProvider>
              <TooltipProvider>
                <BreadcrumbProvider>
                  <SidebarProvider>
                    <PanelProvider>
                      <DialogProvider>{children}</DialogProvider>
                    </PanelProvider>
                  </SidebarProvider>
                </BreadcrumbProvider>
              </TooltipProvider>
            </ToastProvider>
          </CompanyProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}
