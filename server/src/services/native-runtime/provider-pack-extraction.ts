// Probe every tool and tar option used by either transport before staging bytes.
// A host with plain tar support can still use the existing directory fallback.
export const providerPackExtractionProbe = [
  "command -v zstd >/dev/null 2>&1",
  "command -v sha256sum >/dev/null 2>&1",
  "command -v cut >/dev/null 2>&1",
  "tar_version=$(tar --zstd --ignore-zeros --no-same-owner --same-permissions --delay-directory-restore --version 2>/dev/null)",
  'case "$tar_version" in *"GNU tar"*) true ;; *) false ;; esac',
].join(" && ");
