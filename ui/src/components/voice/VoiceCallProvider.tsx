import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { NativeVoiceConversation, type NativeVoiceConversationProps } from "./NativeVoiceConversation";
import { voiceCallJournal } from "@/lib/voice-call-attempt";
import { VoiceCallContext } from "./VoiceCallContext";

/** Owns media above routes. Scope changes unmount the call and clean up media. */
export function VoiceCallProvider({ children, companyId, userId }: {
  children: ReactNode; companyId: string | null; userId: string | null;
}) {
  const [call, setCall] = useState<{ props: NativeVoiceConversationProps; userId: string | null; id: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [ended, setEnded] = useState(false);
  const current = call?.props.companyId === companyId && call.userId === userId ? call : null;
  useEffect(() => { if (call && !current) setCall(null); }, [call, current]);
  const open = useCallback((props: NativeVoiceConversationProps) => {
    if (props.companyId !== companyId || current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEnded(false); setCall({ props: { ...props, journal: props.journal ?? (props.client ? undefined : voiceCallJournal(sessionStorage, props.companyId, userId ?? "unresolved")) }, userId, id: crypto.randomUUID() });
  }, [companyId, userId, current]);
  const value = useMemo(() => ({ active: Boolean(current), open }), [current, open]);
  return <VoiceCallContext.Provider value={value}>
    {children}
    {current && <aside aria-label="Current voice call" className="fixed inset-x-4 bottom-4 z-50 max-h-(--sz-calc-18) overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg sm:left-auto sm:w-96">
      <NativeVoiceConversation {...current.props} key={current.id} managed autoStart onEndedChange={setEnded} />
      {ended && <Button variant="ghost" size="sm" onClick={() => { setCall(null); requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }); }}>Close voice panel</Button>}
    </aside>}
  </VoiceCallContext.Provider>;
}
