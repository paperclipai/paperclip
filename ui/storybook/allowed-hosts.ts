/** Exact hostnames shared by Storybook's HTTP and websocket origin checks. */
export function storybookAllowedHosts(machineHostname: string, additionalHosts = ""): string[] {
  const normalize = (value: string) => {
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    const labels = host.split(".");
    if (host.length > 253 || labels.some((label) => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) {
      throw new Error("PAPERCLIP_STORYBOOK_ALLOWED_HOSTS requires exact hostnames without schemes, ports, paths, or wildcards.");
    }
    return host;
  };
  const machine = normalize(machineHostname);
  const shortName = machine.split(".")[0]!;
  const extra = additionalHosts.split(/[,\s]+/).filter(Boolean).map(normalize);
  return [...new Set(["localhost", machine, shortName, `${shortName}.local`, ...extra])];
}
