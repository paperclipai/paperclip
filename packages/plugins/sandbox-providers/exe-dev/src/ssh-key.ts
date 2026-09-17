export function validateSshPrivateKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;

  if (/^PuTTY-User-Key-File-\d/m.test(trimmed)) {
    return "sshPrivateKey looks like a PuTTY .ppk file. Convert it to OpenSSH format (PuTTYgen → Conversions → Export OpenSSH key) and paste the resulting PEM.";
  }

  if (
    /^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-[a-z0-9-]+|sk-(?:ssh-ed25519|ecdsa-sha2-[a-z0-9-]+)@openssh\.com)\s+\S/.test(
      trimmed,
    )
  ) {
    return "sshPrivateKey looks like a PUBLIC key. Paste the matching private key (the file without the .pub extension).";
  }

  const headerMatch = trimmed.match(/^-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/m);
  if (!headerMatch) {
    return "sshPrivateKey must be a PEM-encoded private key starting with a line like '-----BEGIN OPENSSH PRIVATE KEY-----'.";
  }

  const footerMatch = trimmed.match(/^-----END ([A-Z0-9 ]*)PRIVATE KEY-----\s*$/m);
  if (!footerMatch) {
    return "sshPrivateKey is missing its '-----END … PRIVATE KEY-----' footer. Make sure you copied the whole file, including the final line.";
  }

  const headerLabel = headerMatch[1].trim();
  const footerLabel = footerMatch[1].trim();
  if (headerLabel !== footerLabel) {
    return `sshPrivateKey header/footer mismatch (BEGIN ${headerLabel || "(none)"} vs END ${footerLabel || "(none)"}). The file is likely truncated or two keys are concatenated.`;
  }

  const headerLineEnd = trimmed.indexOf("\n", headerMatch.index ?? 0);
  const footerStart = trimmed.lastIndexOf(footerMatch[0]);
  if (headerLineEnd < 0 || footerStart <= headerLineEnd) {
    return "sshPrivateKey appears to be empty between its BEGIN and END markers.";
  }

  const bodyLines = trimmed
    .slice(headerLineEnd + 1, footerStart)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (bodyLines.length === 0) {
    return "sshPrivateKey appears to be empty between its BEGIN and END markers.";
  }

  // PEM bodies are base64 lines, optionally preceded by `Header: value` lines
  // on encrypted PKCS#1 keys (`Proc-Type:`, `DEK-Info:`).
  const base64Line = /^[A-Za-z0-9+/=]+$/;
  const pemHeaderLine = /^[A-Za-z][A-Za-z0-9-]*:\s.+$/;
  for (const line of bodyLines) {
    if (!base64Line.test(line) && !pemHeaderLine.test(line)) {
      return "sshPrivateKey body contains non-base64 characters. The key may have been corrupted by line-wrapping or copy-paste.";
    }
  }

  return null;
}

