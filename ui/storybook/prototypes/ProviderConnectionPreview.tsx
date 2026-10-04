import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { OnboardingCardField, OnboardingLoginCard, OnboardingLoginCodeRow } from "@/components/AdapterLoginChrome";
import { ModelSourceTiles } from "@/components/onboarding/ModelSourceTiles";
import { CredentialModeLink } from "@/components/onboarding/CredentialModeLink";
import { FooterNav } from "@/components/onboarding/FooterNav";
import { CARD_ENTER, CARD_EXIT, CONNECTED_HOLD_MS, MAKE_ROOM, MAKE_ROOM_MS, SOURCE_COLLAPSE_MS, SOURCE_LINK_EXIT, beatDelay } from "@/components/onboarding/onboarding-motion";

export type ConnectionMethod = "subscription" | "api";
export type ConnectionProvider = "Claude" | "OpenAI";
type Phase = "idle" | "collapsing" | "opening" | "ready" | "waiting" | "connecting";

/** The shipped onboarding presentation and choreography, with a local provider
 * simulator. Example keys/codes never leave React state or reach storage. */
export function ProviderConnectionPreview({ provider, initialMethod = "subscription", initialWaiting = false, onConnected }: {
  provider: ConnectionProvider;
  initialMethod?: ConnectionMethod;
  initialWaiting?: boolean;
  onConnected: (method: ConnectionMethod) => void;
}) {
  const [method, setMethod] = useState<ConnectionMethod>(initialMethod);
  const [phase, setPhase] = useState<Phase>(initialWaiting ? "waiting" : initialMethod === "api" ? "ready" : "idle");
  const [value, setValue] = useState("");
  const pasted = useRef(false);
  useEffect(() => {
    if (!pasted.current || !value.trim() || method !== "subscription") return;
    pasted.current = false;
    setValue(""); setPhase("connecting");
  }, [value, method]);
  useEffect(() => {
    const next = phase === "collapsing" ? "opening" : phase === "opening" ? "ready" : null;
    if (!next && phase !== "connecting") return;
    const duration = phase === "collapsing" ? SOURCE_COLLAPSE_MS : phase === "opening" ? MAKE_ROOM_MS : CONNECTED_HOLD_MS;
    const timer = window.setTimeout(() => next ? setPhase(next) : onConnected(method), beatDelay(duration));
    return () => window.clearTimeout(timer);
  }, [phase, method, onConnected]);
  const finish = () => {
    if ((method === "api" || provider === "Claude") && !value.trim()) return;
    setValue(""); setPhase("connecting");
  };
  const cancel = () => { setValue(""); setPhase("idle"); };
  const cardSpace = phase !== "idle" && phase !== "collapsing";
  const live = cardSpace && phase !== "opening";
  const connecting = phase === "connecting";
  return <div>
    <ModelSourceTiles label="Connect your model provider" sources={[{
      id: provider, label: provider,
      icon: <img src={provider === "Claude" ? "/brands/claude-color.svg" : "/brands/codex-color.svg"} alt="" className="size-6" />,
    }]} mode={method} selectedId={phase === "idle" ? null : provider} collapsed={phase !== "idle"}
      onSelect={() => { if (phase === "idle") setPhase("collapsing"); }} />
    <motion.div className="overflow-hidden" inert={phase !== "idle"} initial={false}
      animate={{ opacity: phase === "idle" ? 1 : 0, height: cardSpace ? 0 : "auto" }}
      transition={{ opacity: SOURCE_LINK_EXIT, height: MAKE_ROOM }}>
      <div className="-ml-3 mt-1"><CredentialModeLink mode={method} onChange={setMethod} /></div>
    </motion.div>
    <motion.div className="overflow-hidden" inert={!live} initial={false}
      animate={{ height: cardSpace ? "auto" : 0, opacity: live ? 1 : 0 }}
      transition={{ height: MAKE_ROOM, opacity: live ? { ...CARD_ENTER, delay: MAKE_ROOM.duration } : CARD_EXIT }}>
      {cardSpace && <div className="pt-5">
        <OnboardingLoginCard loading={!live} instruction={method === "api"
          ? `Provide your ${provider} API key to connect`
          : provider === "Claude" ? <><button type="button" className="underline underline-offset-2" onClick={() => setPhase("waiting")}>Sign in to Claude</button> then come back and enter authorization code</>
          : <><button type="button" className="underline underline-offset-2" onClick={() => setPhase("waiting")}>Sign in to OpenAI</button> and enter this code</>}>
          {method === "api" || provider === "Claude"
            ? <OnboardingCardField key={method} label={method === "api" ? "API key" : "Authorization code"} placeholder={method === "api" ? "Enter API key here" : "Enter authorization code"}
                masked={method === "api"} autoFocus value={value} onPaste={() => { if (method === "subscription") pasted.current = true; }} onChange={setValue} onSubmit={finish} disabled={connecting} />
            : <OnboardingLoginCodeRow code="STORY-BOOK" />}
        </OnboardingLoginCard>
      </div>}
    </motion.div>
    <FooterNav onBack={phase !== "idle" ? cancel : undefined}
      primaryLabel={connecting ? "Connecting" : phase === "idle" ? "Next" : method === "api" ? "Connect" : value.trim() ? "Connect" : phase === "waiting" ? "Waiting for code" : `Sign in to ${provider}`}
      primaryDisabled={phase === "idle" || phase === "collapsing" || phase === "opening" || (method === "api" && !value.trim()) || (phase === "waiting" && !value.trim())}
      loading={connecting} primaryIcon={connecting || phase === "waiting" && !value.trim() ? "spinner" : method === "api" ? "arrow" : "none"}
      onPrimary={() => method === "api" || value.trim() ? finish() : setPhase("waiting")} />
    {provider === "OpenAI" && method === "subscription" && phase === "waiting" &&
      <div className="mt-6 text-center"><Button variant="ghost" size="sm" onClick={finish}>Simulate completed sign-in</Button></div>}
  </div>;
}
