import { Suspense, lazy, useEffect, useState } from "react";
import { useSidebar } from "../context/SidebarContext";

const LazyCommandPaletteDialog = lazy(async () => {
  const module = await import("./CommandPaletteDialog");
  return { default: module.CommandPaletteDialog };
});

export function CommandPalette() {
  const { isMobile, setSidebarOpen } = useSidebar();
  const [shouldLoad, setShouldLoad] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setShouldLoad(true);
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setSidebarOpen]);

  if (!shouldLoad) return null;

  return (
    <Suspense fallback={null}>
      <LazyCommandPaletteDialog open={open} onOpenChange={setOpen} />
    </Suspense>
  );
}
