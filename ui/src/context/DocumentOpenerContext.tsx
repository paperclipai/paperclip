import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { documentOpenerHealth, type DocumentOpenerStatus } from "../lib/local-document";

const POLL_INTERVAL_MS = 30_000;

const DocumentOpenerStatusContext = createContext<DocumentOpenerStatus>("unavailable");

export function DocumentOpenerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DocumentOpenerStatus>("unavailable");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function check() {
      const next = await documentOpenerHealth();
      if (mountedRef.current) setStatus(next);
    }

    void check();
    const handle = window.setInterval(() => void check(), POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, []);

  return (
    <DocumentOpenerStatusContext.Provider value={status}>
      {children}
    </DocumentOpenerStatusContext.Provider>
  );
}

export function useDocumentOpenerStatus(): DocumentOpenerStatus {
  return useContext(DocumentOpenerStatusContext);
}
