import { useEffect, useRef } from "react";

const CHARS = [" ", ".", "·", "▪", "▫", "○"] as const;
const TARGET_FPS = 24;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

const PAPERCLIP_SPRITES = [
  [
    "  ╭────╮ ",
    " ╭╯╭──╮│ ",
    " │ │  ││ ",
    " │ │  ││ ",
    " │ │  ││ ",
    " │ │  ││ ",
    " │ ╰──╯│ ",
    " ╰─────╯ ",
  ],
  [
    " ╭─────╮ ",
    " │╭──╮╰╮ ",
    " ││  │ │ ",
    " ││  │ │ ",
    " ││  │ │ ",
    " ││  │ │ ",
    " │╰──╯ │ ",
    " ╰────╯  ",
  ],
] as const;

type PaperclipSprite = (typeof PAPERCLIP_SPRITES)[number];

interface Clip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  drift: number;
  sprite: PaperclipSprite;
  width: number;
  height: number;
}

function measureChar(container: HTMLElement): { w: number; h: number } {
  const span = document.createElement("span");
  span.textContent = "M";
  span.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;font-size:11px;font-family:monospace;line-height:1;";
  container.appendChild(span);
  const rect = span.getBoundingClientRect();
  container.removeChild(span);
  return { w: rect.width, h: rect.height };
}

function spriteSize(sprite: PaperclipSprite): { width: number; height: number } {
  let width = 0;
  for (const row of sprite) width = Math.max(width, row.length);
  return { width, height: sprite.length };
}

export function AsciiArtAnimation() {
  const preRef = useRef<HTMLPreElement>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!preRef.current) return;
    const preEl: HTMLPreElement = preRef.current;
    const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    let isVisible = document.visibilityState !== "hidden";
    let loopActive = false;
    let lastRenderAt = 0;
    let tick = 0;
    let cols = 0;
    let rows = 0;
    let charW = 7;
    let charH = 11;
    let trail = new Float32Array(0);
    let colWave = new Float32Array(0);
    let rowWave = new Float32Array(0);
    let clipMask = new Uint16Array(0);
    let clips: Clip[] = [];
    let lastOutput = "";

    function toGlyph(value: number): string {
      const clamped = Math.max(0, Math.min(0.999, value));
      const idx = Math.floor(clamped * CHARS.length);
      return CHARS[idx] ?? " ";
    }

    function rebuildGrid() {
      const nextCols = Math.max(0, Math.ceil(preEl.clientWidth / Math.max(1, charW)));
      const nextRows = Math.max(0, Math.ceil(preEl.clientHeight / Math.max(1, charH)));
      if (nextCols === cols && nextRows === rows) return;

      cols = nextCols;
      rows = nextRows;
      const cellCount = cols * rows;
      trail = new Float32Array(cellCount);
      colWave = new Float32Array(cols);
      rowWave = new Float32Array(rows);
      clipMask = new Uint16Array(cellCount);
      clips = clips.filter((clip) => {
        return (
          clip.x > -clip.width - 2 &&
          clip.x < cols + 2 &&
          clip.y > -clip.height - 2 &&
          clip.y < rows + 2
        );
      });
      lastOutput = "";
    }

    function drawStaticFrame() {
      if (cols <= 0 || rows <= 0) {
        preEl.textContent = "";
        return;
      }

      const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ambient = (Math.sin(c * 0.11 + r * 0.04) + Math.cos(r * 0.08 - c * 0.02)) * 0.18 + 0.22;
          grid[r]![c] = toGlyph(ambient);
        }
      }

      const gapX = 18;
      const gapY = 13;
      for (let baseRow = 1; baseRow < rows - 9; baseRow += gapY) {
        const startX = Math.floor(baseRow / gapY) % 2 === 0 ? 2 : 10;
        for (let baseCol = startX; baseCol < cols - 10; baseCol += gapX) {
          const sprite = PAPERCLIP_SPRITES[(baseCol + baseRow) % PAPERCLIP_SPRITES.length]!;
          for (let sr = 0; sr < sprite.length; sr++) {
            const line = sprite[sr]!;
            for (let sc = 0; sc < line.length; sc++) {
              const ch = line[sc] ?? " ";
              if (ch === " ") continue;
              const row = baseRow + sr;
              const col = baseCol + sc;
              if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
              grid[row]![col] = ch;
            }
          }
        }
      }

      const output = grid.map((line) => line.join("")).join("\n");
      preEl.textContent = output;
      lastOutput = output;
    }

    function spawnClip() {
      const sprite = PAPERCLIP_SPRITES[Math.floor(Math.random() * PAPERCLIP_SPRITES.length)]!;
      const size = spriteSize(sprite);
      const edge = Math.random();
      let x = 0;
      let y = 0;
      let vx = 0;
      let vy = 0;

      if (edge < 0.68) {
        x = Math.random() < 0.5 ? -size.width - 1 : cols + 1;
        y = Math.random() * Math.max(1, rows - size.height);
        vx = x < 0 ? 0.04 + Math.random() * 0.05 : -(0.04 + Math.random() * 0.05);
        vy = (Math.random() - 0.5) * 0.014;
      } else {
        x = Math.random() * Math.max(1, cols - size.width);
        y = Math.random() < 0.5 ? -size.height - 1 : rows + 1;
        vx = (Math.random() - 0.5) * 0.014;
        vy = y < 0 ? 0.028 + Math.random() * 0.034 : -(0.028 + Math.random() * 0.034);
      }

      clips.push({
        x,
        y,
        vx,
        vy,
        life: 0,
        maxLife: 260 + Math.random() * 220,
        drift: (Math.random() - 0.5) * 1.2,
        sprite,
        width: size.width,
        height: size.height,
      });
    }

    function stampClip(clip: Clip, alpha: number) {
      const baseCol = Math.round(clip.x);
      const baseRow = Math.round(clip.y);
      for (let sr = 0; sr < clip.sprite.length; sr++) {
        const line = clip.sprite[sr]!;
        const row = baseRow + sr;
        if (row < 0 || row >= rows) continue;
        for (let sc = 0; sc < line.length; sc++) {
          const ch = line[sc] ?? " ";
          if (ch === " ") continue;
          const col = baseCol + sc;
          if (col < 0 || col >= cols) continue;
          const idx = row * cols + col;
          const stroke = ch === "│" || ch === "─" ? 0.8 : 0.92;
          trail[idx] = Math.max(trail[idx] ?? 0, alpha * stroke);
          clipMask[idx] = ch.charCodeAt(0);
        }
      }
    }

    function step(time: number) {
      if (!loopActive) return;
      frameRef.current = requestAnimationFrame(step);
      if (time - lastRenderAt < FRAME_INTERVAL_MS || cols <= 0 || rows <= 0) return;

      const delta = Math.min(2, lastRenderAt === 0 ? 1 : (time - lastRenderAt) / 16.6667);
      lastRenderAt = time;
      tick += delta;

      const cellCount = cols * rows;
      const targetCount = Math.max(3, Math.floor(cellCount / 2200));
      while (clips.length < targetCount) spawnClip();

      for (let i = 0; i < trail.length; i++) trail[i] *= 0.92;
      clipMask.fill(0);

      for (let i = clips.length - 1; i >= 0; i--) {
        const clip = clips[i]!;
        clip.life += delta;

        const wobbleX = Math.sin((clip.y + clip.drift + tick * 0.12) * 0.09) * 0.0018;
        const wobbleY = Math.cos((clip.x - clip.drift - tick * 0.09) * 0.08) * 0.0014;
        clip.vx = (clip.vx + wobbleX) * 0.998;
        clip.vy = (clip.vy + wobbleY) * 0.998;

        clip.x += clip.vx * delta;
        clip.y += clip.vy * delta;

        if (
          clip.life >= clip.maxLife ||
          clip.x < -clip.width - 2 ||
          clip.x > cols + 2 ||
          clip.y < -clip.height - 2 ||
          clip.y > rows + 2
        ) {
          clips.splice(i, 1);
          continue;
        }

        const life = clip.life / clip.maxLife;
        const alpha = life < 0.12 ? life / 0.12 : life > 0.88 ? (1 - life) / 0.12 : 1;
        stampClip(clip, alpha);
      }

      for (let c = 0; c < cols; c++) colWave[c] = Math.sin(c * 0.08 + tick * 0.06);
      for (let r = 0; r < rows; r++) rowWave[r] = Math.cos(r * 0.1 - tick * 0.05);

      let output = "";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const clipChar = clipMask[idx];
          if (clipChar > 0) {
            output += String.fromCharCode(clipChar);
            continue;
          }

          const ambient = 0.2 + colWave[c]! * 0.08 + rowWave[r]! * 0.06 + Math.sin((c + r) * 0.1 + tick * 0.035) * 0.05;
          output += toGlyph((trail[idx] ?? 0) + ambient);
        }
        if (r < rows - 1) output += "\n";
      }

      if (output !== lastOutput) {
        preEl.textContent = output;
        lastOutput = output;
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      const measured = measureChar(preEl);
      charW = measured.w || 7;
      charH = measured.h || 11;
      rebuildGrid();
      if (motionMedia.matches || !isVisible) {
        drawStaticFrame();
      }
    });

    function startLoop() {
      if (loopActive) return;
      loopActive = true;
      lastRenderAt = 0;
      frameRef.current = requestAnimationFrame(step);
    }

    function stopLoop() {
      loopActive = false;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    }

    function syncMode() {
      if (motionMedia.matches || !isVisible) {
        stopLoop();
        drawStaticFrame();
      } else {
        startLoop();
      }
    }

    function handleVisibility() {
      isVisible = document.visibilityState !== "hidden";
      syncMode();
    }

    const measured = measureChar(preEl);
    charW = measured.w || 7;
    charH = measured.h || 11;
    rebuildGrid();
    resizeObserver.observe(preEl);
    motionMedia.addEventListener("change", syncMode);
    document.addEventListener("visibilitychange", handleVisibility);
    syncMode();

    return () => {
      stopLoop();
      resizeObserver.disconnect();
      motionMedia.removeEventListener("change", syncMode);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return (
    <div
      style={{
        height: "320px",
        minHeight: "320px",
        maxHeight: "350px",
        background: "#1d1d1d",
        color: "#f2efe6",
        overflow: "hidden",
        borderRadius: "12px",
        border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
      }}
    >
      <pre
        ref={preRef}
        aria-hidden="true"
        style={{
          margin: 0,
          width: "100%",
          height: "100%",
          padding: "14px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
          fontSize: "11px",
          lineHeight: 1,
          whiteSpace: "pre",
          userSelect: "none",
        }}
      />
    </div>
  );
}
