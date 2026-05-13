export type NotificationCueType = "done" | "attention";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!audioCtx || audioCtx.state === "closed") {
    try {
      audioCtx = new AudioContext();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

function scheduleTone(
  ctx: AudioContext,
  startTime: number,
  frequency: number,
  durationSec: number,
  gainPeak: number,
  attackSec: number,
  releaseSec: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, startTime);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + attackSec);
  gain.gain.setValueAtTime(gainPeak, startTime + durationSec - releaseSec);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + durationSec);
}

// Soft chime ~300ms: single tone at 880 Hz.
function playDoneViaWebAudio(ctx: AudioContext): void {
  const t = ctx.currentTime;
  scheduleTone(ctx, t, 880, 0.30, 0.15, 0.02, 0.25);
  scheduleTone(ctx, t + 0.15, 1047, 0.22, 0.10, 0.01, 0.20);
}

// Two-tone attention ~600ms: 660 Hz then 880 Hz.
function playAttentionViaWebAudio(ctx: AudioContext): void {
  const t = ctx.currentTime;
  scheduleTone(ctx, t, 660, 0.22, 0.18, 0.01, 0.18);
  scheduleTone(ctx, t + 0.25, 880, 0.30, 0.18, 0.01, 0.25);
}

async function resumeContext(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === "running";
}

export async function playCue(type: NotificationCueType): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;

  const ready = await resumeContext(ctx);
  if (!ready) return;

  if (type === "done") {
    playDoneViaWebAudio(ctx);
  } else {
    playAttentionViaWebAudio(ctx);
  }
}

export function primeAudioContext(): void {
  getAudioContext();
}
