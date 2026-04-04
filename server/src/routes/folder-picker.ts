import { Router } from "express";
import { execFile } from "node:child_process";

function pickFolder(): Promise<string | null> {
  const platform = process.platform;

  return new Promise((resolve) => {
    if (platform === "darwin") {
      execFile(
        "osascript",
        [
          "-e",
          'set chosenFolder to POSIX path of (choose folder with prompt "Select project folder")',
        ],
        { timeout: 60_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = stdout.trim().replace(/\/+$/, "");
          resolve(p || null);
        },
      );
    } else if (platform === "win32") {
      const ps = [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select project folder'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }`,
      ];
      execFile("powershell.exe", ps, { timeout: 60_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const p = stdout.trim();
        resolve(p || null);
      });
    } else {
      // Linux — try zenity, fall back to kdialog
      execFile(
        "zenity",
        ["--file-selection", "--directory", "--title=Select project folder"],
        { timeout: 60_000 },
        (err, stdout) => {
          if (!err && stdout.trim()) return resolve(stdout.trim());
          execFile(
            "kdialog",
            ["--getexistingdirectory", ".", "--title", "Select project folder"],
            { timeout: 60_000 },
            (err2, stdout2) => {
              if (err2) return resolve(null);
              resolve(stdout2.trim() || null);
            },
          );
        },
      );
    }
  });
}

export function folderPickerRoutes() {
  const router = Router();

  router.post("/folder-picker", async (_req, res) => {
    try {
      const folder = await pickFolder();
      if (folder) {
        res.json({ path: folder });
      } else {
        res.json({ path: null });
      }
    } catch {
      res.status(500).json({ error: "Failed to open folder picker" });
    }
  });

  return router;
}
