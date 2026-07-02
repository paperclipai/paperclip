import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/context/ToastContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ReviewQueueCard } from "@/pages/apps/ReviewQueueCard";
import "@/index.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const Root = () => (
  <QueryClientProvider client={client}>
    <ThemeProvider>
      <ToastProvider>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>PAP-11227 — ReviewQueueCard live harness</h1>
        <p style={{ opacity: 0.6, fontSize: 12, marginBottom: 16 }}>
          Real component, real API client, mocked endpoints. Network calls are visible at <code>/api/__qa/log</code>.
        </p>
        <ReviewQueueCard emptyState="reassure" />
      </ToastProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

const el = document.getElementById("root");
if (el) createRoot(el).render(<Root />);
