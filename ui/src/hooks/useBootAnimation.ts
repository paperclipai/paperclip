import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Adds `.hud-boot` class to the given element ref on route changes,
 * triggering the boot-in CSS animation. Removes the class after
 * the animation completes to allow re-triggering on next navigation.
 */
export function useBootAnimation<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const location = useLocation();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.classList.add("hud-boot");

    const handleEnd = () => {
      el.classList.remove("hud-boot");
    };

    el.addEventListener("animationend", handleEnd, { once: true });

    return () => {
      el.removeEventListener("animationend", handleEnd);
      el.classList.remove("hud-boot");
    };
  }, [location.pathname]);

  return ref;
}
