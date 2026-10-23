import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { EyeOff, LoaderCircle, QrCode, Smartphone, Trash2 } from "lucide-react";
import { accessApi, type BoardApiKeyCreated } from "@/api/access";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MOBILE_KEY_PREFIX = "Mobile app";
const PAIRING_KEY_LIFETIME_DAYS = 90;
const boardApiKeysQueryKey = ["board-api-keys"] as const;

/** Deep link understood by the Paperclip Android app (`paperclip://connect`). */
export function buildPairingLink(baseUrl: string, token: string) {
  const params = new URLSearchParams({ url: baseUrl.trim().replace(/\/+$/, ""), key: token });
  return `paperclip://connect?${params.toString()}`;
}

function isLoopbackUrl(url: string) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "never";
}

export function MobileAppPairing() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<BoardApiKeyCreated | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);

  const keysQuery = useQuery({
    queryKey: boardApiKeysQueryKey,
    queryFn: () => accessApi.listBoardApiKeys(),
    // While a code is on screen, poll so the panel notices when the phone connects.
    refetchInterval: pairing ? 3000 : false,
  });
  const mobileKeys = (keysQuery.data ?? []).filter((key) => key.name.startsWith(MOBILE_KEY_PREFIX));

  const createMutation = useMutation({
    mutationFn: () => {
      const expiresAt = new Date(Date.now() + PAIRING_KEY_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString();
      return accessApi.createBoardApiKey({
        name: `${MOBILE_KEY_PREFIX} (${new Date().toISOString().slice(0, 10)})`,
        expiresAt,
      });
    },
    onSuccess: (created) => {
      setError(null);
      setNotice(null);
      setPairing(created);
      setServerUrl(created.tailscaleBaseUrl ?? created.publicBaseUrl);
      void queryClient.invalidateQueries({ queryKey: boardApiKeysQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to create a pairing key."),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => accessApi.revokeBoardApiKey(keyId),
    onSuccess: (_result, keyId) => {
      setError(null);
      if (pairing?.id === keyId) clearPairing();
      void queryClient.invalidateQueries({ queryKey: boardApiKeysQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to revoke the key."),
  });

  // Drops every copy of the plaintext token: component state and the react-query mutation cache.
  function clearPairing() {
    setPairing(null);
    createMutation.reset();
  }

  // Hiding the code before any phone used the key revokes it, so no unused key is left behind.
  function hidePairing() {
    if (!pairing) return;
    const used = mobileKeys.find((key) => key.id === pairing.id)?.lastUsedAt;
    if (used) clearPairing();
    else revokeMutation.mutate(pairing.id);
  }

  // Once the phone has used the key, the code is no longer needed on screen.
  useEffect(() => {
    if (!pairing) return;
    if (mobileKeys.some((key) => key.id === pairing.id && key.lastUsedAt)) {
      clearPairing();
      setNotice("Phone connected.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysQuery.data, pairing]);

  // Leaving the page while an unused code is showing revokes that key.
  const pendingKeyId = useRef<string | null>(null);
  pendingKeyId.current = pairing?.id ?? null;
  useEffect(
    () => () => {
      const keyId = pendingKeyId.current;
      if (!keyId) return;
      void accessApi
        .listBoardApiKeys()
        .then((keys) => {
          if (!keys.find((key) => key.id === keyId)?.lastUsedAt) return accessApi.revokeBoardApiKey(keyId);
        })
        .catch(() => undefined);
    },
    [],
  );

  const pairingLink = pairing && serverUrl.trim() ? buildPairingLink(serverUrl, pairing.token) : null;

  useEffect(() => {
    if (!pairingLink) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(pairingLink, { errorCorrectionLevel: "M", margin: 2, width: 320 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to render QR code.");
      });
    return () => {
      cancelled = true;
    };
  }, [pairingLink]);

  return (
    <Card className="block space-y-4 p-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Smartphone className="size-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Mobile app</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Pair the Paperclip Android app by scanning a QR code. Each pairing creates a board API key that
          acts as you and expires after {PAIRING_KEY_LIFETIME_DAYS} days. Revoke it here if the phone is lost.
        </p>
      </div>

      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="text-sm text-muted-foreground">
          {notice}
        </div>
      ) : null}

      {pairing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mobile-pairing-url">Server address the phone will use</Label>
            <Input
              id="mobile-pairing-url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="http://100.x.y.z:3100"
            />
            <p className="text-xs text-muted-foreground">
              {pairing.tailscaleBaseUrl
                ? "Using this machine's Tailscale address. The phone must be signed in to the same tailnet."
                : "No Tailscale address was found on the server. Enter an address the phone can reach."}
            </p>
            {isLoopbackUrl(serverUrl) ? (
              <p role="alert" className="text-xs text-destructive">
                A localhost address only works on this computer. Use the Tailscale or LAN address instead.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-start gap-6">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Pairing QR code for the Paperclip Android app"
                className="size-64 rounded-md border border-border"
              />
            ) : (
              <div className="flex size-64 items-center justify-center rounded-md border border-border">
                <LoaderCircle aria-label="Generating QR code" className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-3 text-sm text-muted-foreground">
              <p>In the app, tap <span className="font-medium text-foreground">Scan QR code</span> on the sign-in screen, or scan with the phone camera.</p>
              <p>Anyone who sees this code can act as you until the key is revoked. It hides itself once the phone connects; hiding it earlier revokes the unused key.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={hidePairing} disabled={revokeMutation.isPending}>
                  <EyeOff className="size-4" />
                  Hide code
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => revokeMutation.mutate(pairing.id)}
                  disabled={revokeMutation.isPending}
                >
                  <Trash2 className="size-4" />
                  Cancel pairing
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Button type="button" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
          {createMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <QrCode className="size-4" />}
          Pair a phone
        </Button>
      )}

      {mobileKeys.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Paired devices</h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {mobileKeys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate">{key.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Last used {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"} · expires{" "}
                    {formatDate(key.expiresAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => revokeMutation.mutate(key.id)}
                  disabled={revokeMutation.isPending && revokeMutation.variables === key.id}
                  aria-label={`Revoke ${key.name}`}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
