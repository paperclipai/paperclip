import * as React from "react";

import type { ConnectionStatus } from "../browser/protocol.js";
import { Banner, BannerActions, BannerText } from "./components/banner.js";
import { Button } from "./components/button.js";

export function ConnectionBanner({
  connection,
  reconnectAttempt,
  onRetry,
}: {
  connection: ConnectionStatus;
  reconnectAttempt: number;
  onRetry: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const blocking = connection === "disconnected";
  React.useEffect(() => {
    if (blocking) ref.current?.focus();
  }, [blocking]);
  if (connection !== "disconnected" && connection !== "reconnecting") return null;
  return (
    <Banner
      ref={ref}
      data-slot="connection-banner"
      tone="warning"
      assertive={blocking}
      tabIndex={blocking ? -1 : undefined}
      data-testid="reconnect-banner"
    >
      <BannerText>
        {connection === "reconnecting"
          ? `Connection lost — reconnecting (attempt ${reconnectAttempt})…`
          : "Connection lost — the session is still on the server."}
      </BannerText>
      <BannerActions><Button type="button" onClick={onRetry}>Retry now</Button></BannerActions>
    </Banner>
  );
}
