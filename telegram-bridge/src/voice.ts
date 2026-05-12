/**
 * Voice transcription via local Whisper CLI.
 * Lifted from ~/nanoclaw/v2/transcribe.ts (P1A-3 follow-up).
 *
 * Pipeline:
 *   1. bot.api.getFile(fileId) → file_path on Telegram CDN
 *   2. fetch that URL → /tmp/tg-voice-<id>.ogg
 *   3. spawn whisper with the local file
 *   4. read whisper's .txt output
 *   5. clean up temp files
 */

import { join } from "path";
import { existsSync, unlinkSync } from "fs";

const WHISPER_BIN = "/opt/homebrew/bin/whisper";
const WHISPER_MODEL = "base";
const WHISPER_LANG = "en";

export type TranscriptionResult = {
  text: string;
  durationMs: number;
  error?: string;
};

export async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
  const start = Date.now();
  if (!existsSync(audioPath)) {
    return { text: "", durationMs: 0, error: `File not found: ${audioPath}` };
  }
  const outputDir = "/tmp";
  const baseName = audioPath.replace(/\.[^.]+$/, "").split("/").pop() || "audio";
  try {
    const proc = Bun.spawn(
      [
        WHISPER_BIN,
        audioPath,
        "--model",
        WHISPER_MODEL,
        "--language",
        WHISPER_LANG,
        "--output_dir",
        outputDir,
        "--output_format",
        "txt",
        "--fp16",
        "False",
        "--verbose",
        "False",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 60_000 },
    );
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      return {
        text: "",
        durationMs: Date.now() - start,
        error: `Whisper exited ${exitCode}: ${stderr.slice(0, 200)}`,
      };
    }
    const tryRead = async (path: string) => {
      try {
        const t = (await Bun.file(path).text()).trim();
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
        return t;
      } catch {
        return null;
      }
    };
    const txtPath = join(outputDir, `${baseName}.txt`);
    let transcript = await tryRead(txtPath);
    if (transcript === null) {
      const altBase = audioPath.split("/").pop()?.replace(/\.[^.]+$/, "") || baseName;
      transcript = await tryRead(join(outputDir, `${altBase}.txt`));
    }
    if (transcript === null) {
      return { text: "", durationMs: Date.now() - start, error: "Whisper output not found" };
    }
    return { text: transcript, durationMs: Date.now() - start };
  } catch (err: any) {
    return {
      text: "",
      durationMs: Date.now() - start,
      error: String(err?.message || err),
    };
  }
}

export async function downloadTelegramFile(
  botApi: { getFile: (fileId: string) => Promise<{ file_path?: string }> },
  token: string,
  fileId: string,
): Promise<{ localPath: string; ext: string } | { error: string }> {
  try {
    const file = await botApi.getFile(fileId);
    if (!file.file_path) return { error: "No file_path returned" };
    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const resp = await fetch(fileUrl);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const ext = (file.file_path || "").split(".").pop() || "ogg";
    const localPath = join("/tmp", `tg-voice-${fileId.slice(0, 12)}.${ext}`);
    const buf = await resp.arrayBuffer();
    await Bun.write(localPath, buf);
    return { localPath, ext };
  } catch (err: any) {
    return { error: String(err?.message || err) };
  }
}
