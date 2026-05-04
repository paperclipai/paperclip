import { useEffect, useState } from "react";

function readPageForegrounded() {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function usePageForegrounded() {
  const [isForegrounded, setIsForegrounded] = useState(readPageForegrounded);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsForegrounded(readPageForegrounded());
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return isForegrounded;
}
