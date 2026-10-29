export const MUSE_DEVICE_LOGIN_COMMAND = "muse login";

export interface MuseDeviceLoginPrompt {
  url: string;
  code: string;
}

export function parseMuseDeviceLoginPrompt(output: string): MuseDeviceLoginPrompt | null {
  const urlMatch = output.match(/https?:\/\/[^\s]+/);
  const codeMatch = output.match(/code:\s*([A-Z0-9-]+)/i) || output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  if (!urlMatch || !codeMatch) return null;
  return {
    url: urlMatch[0],
    code: codeMatch[1],
  };
}
