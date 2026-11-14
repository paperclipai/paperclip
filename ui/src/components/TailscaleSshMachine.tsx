import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { tailscaleApi } from "@/api/tailscale";
import { describeError } from "@/api/errors";
import { useTailscaleConnections } from "@/hooks/useTailscaleConnections";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";
import { Field } from "./agent-config-primitives";

export function TailscaleSshMachine(props: {
  companyId: string; connectionId: string; deviceId: string;
  port: number; onPrivateKey: (secretId: string) => void;
  onChange: (selection: { connectionId: string; deviceId: string; host: string }) => void;
}) {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const connections = useTailscaleConnections(props.companyId);
  const connected = (connections.data ?? []).filter(connection => connection.status === "connected");
  const onlyConnectionId = connected.length === 1 ? connected[0]!.id : null;
  const showConnectionSelector = connected.length > 1 || Boolean(props.connectionId && onlyConnectionId && props.connectionId !== onlyConnectionId);
  useEffect(() => {
    if (!props.connectionId && onlyConnectionId) props.onChange({ connectionId: onlyConnectionId, deviceId: "", host: "" });
  }, [props.connectionId, onlyConnectionId, props.onChange]);
  const devices = useQuery({ queryKey: ["tailscale-devices", props.companyId, props.connectionId], queryFn: () => tailscaleApi.devices(props.companyId, props.connectionId), enabled: Boolean(props.connectionId) && connections.canManage });
  const pairing = useMutation({ mutationFn: (selection: { companyId: string; connectionId: string; deviceId: string; port: number }) => tailscaleApi.pairing(selection.companyId, selection.connectionId, selection.deviceId, selection.port),
    onSuccess: (result, selection) => {
      if (mounted.current && selection.companyId === props.companyId && selection.connectionId === props.connectionId && selection.deviceId === props.deviceId && selection.port === props.port) props.onPrivateKey(result.privateKeySecretId);
    } });
  const error = pairing.error ?? connections.error ?? devices.error;
  if (!connections.canManage) return <p className="text-sm text-muted-foreground">An instance administrator must configure this Tailscale machine.</p>;
  return <div className="grid gap-3">
    <p className="text-sm text-muted-foreground"><Link className="underline" to="/apps/tailscale">Manage Tailscale connector</Link></p>
    {showConnectionSelector ? <div className="flex items-center gap-3">
      <Field label="Tailnet connection">
        <select className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm" value={props.connectionId}
          onChange={event => props.onChange({ connectionId: event.target.value, deviceId: "", host: "" })}>
          <option value="">Choose a connection</option>
          {props.connectionId && !connected.some(connection => connection.id === props.connectionId) ? <option value={props.connectionId} disabled>Unavailable connection</option> : null}
          {connected.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
        </select>
      </Field>
    </div> : null}
    {props.connectionId ? <Field label="Machine">
      <select className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm" value={props.deviceId}
        disabled={devices.isPending} onChange={event => {
          const device = devices.data?.find(device => device.id === event.target.value);
          props.onChange({ connectionId: props.connectionId, deviceId: device?.id ?? "", host: device?.address ?? "" });
        }}>
        <option value="">{devices.isPending ? "Loading machines…" : "Choose a machine"}</option>
        {(devices.data ?? []).map(device => <option key={device.id} value={device.id} disabled={!device.online}>{device.name}{device.hostname ? ` — ${device.hostname}` : ""} ({device.os}){device.online ? "" : " — Offline"}</option>)}
      </select>
    </Field> : null}
    {props.deviceId ? <div className="grid gap-3">
      <Button type="button" variant="outline" disabled={pairing.isPending} onClick={() => pairing.mutate({ companyId: props.companyId, connectionId: props.connectionId, deviceId: props.deviceId, port: props.port })}>Prepare machine pairing</Button>
      {pairing.data && pairing.variables?.companyId === props.companyId && pairing.variables?.deviceId === props.deviceId && pairing.variables?.connectionId === props.connectionId && pairing.variables?.port === props.port ? <>
        <p className="text-sm text-muted-foreground">Run this on the selected computer as the user who will run tasks. Enter the printed username, workspace, and known hosts below. Paperclip keeps the private key in its vault.</p>
        <textarea aria-label="Machine pairing command" readOnly rows={8} className="w-full rounded-md border border-border bg-transparent p-3 font-mono text-sm" value={pairing.data.command} />
      </> : null}
    </div> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{describeError(error, { action: "connect Tailscale" }).body}</p> : null}
  </div>;
}
