import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyProvider } from "@/context/CompanyContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { LiveUpdatesProvider } from "@/context/LiveUpdatesContext";
import { App } from "./App";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CompanyProvider>
        <ThemeProvider>
          <SidebarProvider>
            <BrowserRouter>
              <LiveUpdatesProvider>
                <App />
              </LiveUpdatesProvider>
            </BrowserRouter>
          </SidebarProvider>
        </ThemeProvider>
      </CompanyProvider>
    </QueryClientProvider>
  </StrictMode>,
);
