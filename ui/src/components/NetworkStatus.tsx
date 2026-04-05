import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Detects online/offline state and shows a top banner when the
 * browser goes offline. Automatically hides when connectivity returns.
 */
export function NetworkStatus() {
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-md"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>You're offline. Changes will sync when connected.</span>
    </div>
  );
}
