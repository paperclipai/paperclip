import type { ReactNode } from "react";
import { createBrowserRouter } from "@/lib/router";

export function createAppRouter(element: ReactNode) {
  return createBrowserRouter([
    {
      path: "*",
      element,
    },
  ]);
}
