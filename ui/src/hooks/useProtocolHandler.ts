import { useEffect } from "react";

export function useProtocolHandler() {
  useEffect(() => {
    if (location.protocol !== "https:") return;
    if (sessionStorage.getItem("__paperclip_protocol_registered")) return;
    try {
      navigator.registerProtocolHandler(
        "web+paperclip",
        `${location.origin}/install?uri=%s`,
      );
      sessionStorage.setItem("__paperclip_protocol_registered", "1");
    } catch {
      // Browser doesn't support registerProtocolHandler or rejected the call.
    }
  }, []);
}
