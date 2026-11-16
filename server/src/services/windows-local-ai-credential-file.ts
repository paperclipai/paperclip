import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Node cannot open a Windows path relative to a pinned directory handle. Hold
// every ancestor without write/delete sharing before resolving its child, and
// inspect reparse points themselves. Read only from the final checked handle.
const reader = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PaperclipCredentialReader {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh;
        public uint WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern SafeFileHandle Open(string name, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandle", ExactSpelling=true, SetLastError=true)]
    static extern int Inspect(SafeFileHandle handle, out FileInfo info);

    public static byte[] Read(string filename, int limit) {
        if (limit < 0 || limit > 65536 || filename.Length < 3 ||
            !Char.IsLetter(filename[0]) || filename[1] != ':' || filename[2] != '\\' ||
            filename.IndexOf(':', 2) >= 0 || filename.IndexOf('\0') >= 0)
            throw new IOException("Invalid credential path");
        string full = Path.GetFullPath(filename);
        string root = Path.GetPathRoot(full);
        string[] parts = full.Substring(root.Length).Split('\\');
        var handles = new List<SafeFileHandle>();
        try {
            string current = root;
            for (int i = -1; i < parts.Length; i++) {
                if (i >= 0) {
                    if (parts[i].Length == 0) throw new IOException("Invalid credential path");
                    current = Path.Combine(current, parts[i]);
                }
                bool directory = i < parts.Length - 1;
                // FILE_SHARE_READ only; OPEN_EXISTING; OPEN_REPARSE_POINT |
                // BACKUP_SEMANTICS. Parent locks remain held until after reading.
                SafeFileHandle handle = Open(current, directory ? 0x80u : 0x80000000u,
                    1u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
                handles.Add(handle);
                if (handle.IsInvalid && !directory && Marshal.GetLastWin32Error() == 2)
                    throw new FileNotFoundException();
                FileInfo info;
                if (handle.IsInvalid || Inspect(handle, out info) == 0 ||
                    (info.Attributes & 0x400u) != 0 ||
                    ((info.Attributes & 0x10u) != 0) != directory)
                    throw new IOException("Invalid credential handle");
                if (!directory) {
                    if (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > limit)
                        throw new IOException("Invalid credential file");
                    using (var stream = new FileStream(handle, FileAccess.Read)) {
                        byte[] bytes = new byte[limit + 1];
                        int count = 0, read;
                        while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) != 0)
                            count += read;
                        if (count > limit) throw new IOException("Invalid credential size");
                        Array.Resize(ref bytes, count);
                        return bytes;
                    }
                }
            }
            throw new IOException("Missing credential file");
        } finally {
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
        }
    }
}
'@
$credentialPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($credentialPath64))
try {
    [Console]::Out.Write([Convert]::ToBase64String([PaperclipCredentialReader]::Read($credentialPath, $credentialLimit)))
} catch {
    if ($_.Exception.GetBaseException() -is [IO.FileNotFoundException]) {
        [Console]::Out.Write('PAPERCLIP_CREDENTIAL_NOT_FOUND')
        exit 2
    }
    exit 1
}
`;

export async function readWindowsLocalAiCredentialFile(filename: string, maxBytes: number): Promise<string> {
  try {
    if (filename.length > 2048 || maxBytes !== 64 * 1024) throw new Error("Invalid input");
    const command = `$credentialPath64='${Buffer.from(filename, "utf8").toString("base64")}'; $credentialLimit=${maxBytes};\n${reader}`;
    const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stdout)) throw new Error("Invalid output");
    const bytes = Buffer.from(stdout, "base64");
    if (bytes.length > maxBytes) throw new Error("Invalid size");
    return bytes.toString("utf8");
  } catch (error) {
    // Child errors include stdout/stderr. Never propagate credential contents.
    const child = error as { code?: unknown; stdout?: unknown } | null;
    if (child?.code === 2 && child.stdout === "PAPERCLIP_CREDENTIAL_NOT_FOUND") {
      throw Object.assign(new Error("Credential file not found"), { code: "ENOENT" });
    }
    throw new Error("Invalid Windows credential file");
  }
}
