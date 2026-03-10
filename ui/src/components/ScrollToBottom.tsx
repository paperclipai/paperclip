import { useCallback, useEffect, useState } from "react";
import { ArrowDown } from "lucide-react";

/**
 * Floating scroll-to-bottom button that appears when the user is far from the
 * bottom of the `#main-content` scroll container. Hides when within 300px of
 * the bottom. Positioned to avoid the mobile bottom nav.
 */
export function ScrollToBottom() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = document.getElementById("main-content");
    if (!el) return;
    const check = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setVisible(distance > 300);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, []);

  const scroll = useCallback(() => {
    const el = document.getElementById("main-content");
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={scroll}
      className="fixed bottom-[calc(1.5rem+5rem+env(safe-area-inset-bottom))] right-6 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent transition-colors md:bottom-6"
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}
