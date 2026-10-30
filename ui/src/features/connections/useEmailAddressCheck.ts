import { useEffect, useState } from "react";
import type { EmailAddressCheckResult } from "@paperclipai/shared";
import { emailApi } from "@/api/email";

type Check = { key: string; result?: EmailAddressCheckResult; error?: string };

/** Debounce reads, abort superseded requests, and never display an old address's result. */
export function useEmailAddressCheck(companyId: string, connectionId: string, username: string, domain: string, enabled: boolean) {
  const key = JSON.stringify([companyId, connectionId, username, domain]);
  const [check, setCheck] = useState<Check>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      void emailApi.checkAddress(companyId, connectionId, { username, domain }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setCheck({ key, result }); })
        .catch(error => {
          if (!controller.signal.aborted) setCheck({ key, error: error instanceof Error ? error.message : "Could not check this address." });
        });
    }, 350);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [companyId, connectionId, username, domain, key, enabled]);
  const current = enabled && check?.key === key ? check : undefined;
  return { result: current?.result, error: current?.error, checking: enabled && !current };
}
