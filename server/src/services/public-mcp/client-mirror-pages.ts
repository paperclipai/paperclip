import type { McpClientMirrorChange, McpClientMirrorRequest } from "./client-mirror-contract.js";
import type { McpDeviceStatusEntry } from "./device-status-contract.js";
import { mcpClientMirrorPageFits } from "./client-mirror-wire.js";

type ClientPage = Extract<McpClientMirrorRequest, { operation: "append" }>;
type DevicePage = Extract<McpClientMirrorRequest, { operation: "append-device-status" }>;
type Identity = Omit<ClientPage, "operation" | "sequence" | "changes">;

export function mcpClientMirrorClientPages(identity: Identity, sequence: number, changes: McpClientMirrorChange[]): ClientPage[] {
  const pages: ClientPage[]=[];
  let page: McpClientMirrorChange[]=[];
  const request=():ClientPage=>({...identity,operation:"append",sequence:sequence+pages.length,changes:page});
  for(const change of changes){
    const candidate={...request(),changes:[...page,change]};
    if(page.length&&(page.length===200||!mcpClientMirrorPageFits(candidate))){pages.push(request());page=[];}
    page.push(change);
    if(!mcpClientMirrorPageFits(request()))throw new Error("MCP mirrored client exceeds the bounded single-record contract");
  }
  if(page.length)pages.push(request());
  return pages;
}

export function mcpClientMirrorDevicePages(identity: Identity, entries: McpDeviceStatusEntry[]): DevicePage[] {
  const pages: DevicePage[]=[];
  let page: McpDeviceStatusEntry[]=[];
  const request=():DevicePage=>({...identity,operation:"append-device-status",sequence:pages.length,entries:page});
  for(const entry of entries){
    const candidate={...request(),entries:[...page,entry]};
    if(page.length&&(page.length===200||!mcpClientMirrorPageFits(candidate))){pages.push(request());page=[];}
    page.push(entry);
    if(!mcpClientMirrorPageFits(request()))throw new Error("MCP device status exceeds the bounded single-record contract");
  }
  if(page.length)pages.push(request());
  return pages;
}
