import { useEffect, useState } from "react";

function currentDocumentVisibility() {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function useDocumentVisibility() {
  const [isVisible, setIsVisible] = useState(currentDocumentVisibility);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const syncVisibility = () => {
      setIsVisible(currentDocumentVisibility());
    };

    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("focus", syncVisibility);
    window.addEventListener("blur", syncVisibility);

    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("focus", syncVisibility);
      window.removeEventListener("blur", syncVisibility);
    };
  }, []);

  return isVisible;
}
