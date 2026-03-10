import { useEffect, useRef } from "react";

const CHARS = [" ", ".", "\u00b7", "\u25aa", "\u25ab", "\u25cb"] as const;
const TARGET_FPS = 12;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const FONT = "11px monospace";

const PAPERCLIP_SPRITES = [
  [
    "  \u256d\u2500\u2500\u2500\u2500\u256e ",
    " \u256d\u256f\u256d\u2500\u2500\u256e\u2502 ",
    " \u2502 \u2502  \u2502\u2502 ",
    " \u2502 \u2502  \u2502\u2502 ",
    " \u2502 \u2502  \u2502\u2502 ",
    " \u2502 \u2502  \u2502\u2502 ",
    " \u2502 \u2570\u2500\u2500\u256f\u2502 ",
    " \u2570\u2500\u2500\u2500\u2500\u2500\u256f ",
  ],
  [
    " \u256d\u2500\u2500\u2500\u2500\u2500\u256e ",
    " \u2502\u256d\u2500\u2500\u256e\u2570\u256e ",
    " \u2502\u2502  \u2502 \u2502 ",
    " \u2502\u2502  \u2502 \u2502 ",
    " \u2502\u2502  \u2502 \u2502 ",
    " \u2502\u2502  \u2502 \u2502 ",
    " \u2502\u2570\u2500\u2500\u256f \u2502 ",
    " \u2570\u2500\u2500\u2500\u2500\u256f  ",
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

function spriteSize(sprite: PaperclipSprite): { width: number; height: number } {
  let width = 0;
  for (const row of sprite) width = Math.max(width, row.length);
  return { width, height: sprite.length };
}

function resolveColor(canvas: HTMLCanvasElement): string {
  const style = getComputedStyle(canvas);
  const raw = style.color;
  if (!raw) return "rgba(128,128,128,0.6)";
  // Apply the 60% opacity from the Tailwind class
  if (raw.startsWith("rgb(")) {
    return raw.replace("rgb(", "rgba(").replace(")", ",0.6)");
  }
  if (raw.startsWith("rgba(")) {
    // Replace existing alpha with 0.6
    return raw.replace(/,\s*[\d.]+\)$/, ",0.6)");
  }
  return raw;
}

export function AsciiArtAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return;
    const canvas: HTMLCanvasElement = canvasRef.current;
    const wrap: HTMLDivElement = wrapRef.current;
    const _ctx = canvas.getContext("2d", { alpha: true });
    if (!_ctx) return;
    const ctx: CanvasRenderingContext2D = _ctx;

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
    let fillColor = "rgba(128,128,128,0.6)";
    // Pre-allocated row buffer to avoid per-frame allocation
    let rowBuf: string[] = [];

    function toGlyph(value: number): string {
      const clamped = Math.max(0, Math.min(0.999, value));
      const idx = Math.floor(clamped * CHARS.length);
      return CHARS[idx] ?? " ";
    }

    function measureCharSize() {
      ctx.font = FONT;
      const metrics = ctx.measureText("M");
      charW = metrics.width || 7;
      // fontBoundingBoxAscent/Descent available in modern browsers
      charH =
        (metrics.fontBoundingBoxAscent ?? 0) + (metrics.fontBoundingBoxDescent ?? 0) || 13;
    }

    function syncCanvasSize() {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function rebuildGrid() {
      const nextCols = Math.max(0, Math.ceil(wrap.clientWidth / Math.max(1, charW)));
      const nextRows = Math.max(0, Math.ceil(wrap.clientHeight / Math.max(1, charH)));
      if (nextCols === cols && nextRows === rows) return;

      cols = nextCols;
      rows = nextRows;
      const cellCount = cols * rows;
      trail = new Float32Array(cellCount);
      colWave = new Float32Array(cols);
      rowWave = new Float32Array(rows);
      clipMask = new Uint16Array(cellCount);
      rowBuf = new Array(cols);
      clips = clips.filter(
        (clip) =>
          clip.x > -clip.width - 2 &&
          clip.x < cols + 2 &&
          clip.y > -clip.height - 2 &&
          clip.y < rows + 2,
      );
    }

    function renderToCanvas(getCell: (r: number, c: number) => string) {
      ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
      ctx.font = FONT;
      ctx.fillStyle = fillColor;
      ctx.textBaseline = "top";

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          rowBuf[c] = getCell(r, c);
        }
        ctx.fillText(rowBuf.join(""), 0, r * charH);
      }
    }

    function drawStaticFrame() {
      if (cols <= 0 || rows <= 0) {
        ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
        return;
      }

      // Pre-compute static sprites positions
      const grid: string[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => " "),
      );
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ambient =
            (Math.sin(c * 0.11 + r * 0.04) + Math.cos(r * 0.08 - c * 0.02)) * 0.18 + 0.22;
          grid[r][c] = toGlyph(ambient);
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

      renderToCanvas((r, c) => grid[r][c]);
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
          const stroke = ch === "\u2502" || ch === "\u2500" ? 0.8 : 0.92;
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

      // Render directly to canvas — no string building or DOM mutation
      ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
      ctx.font = FONT;
      ctx.fillStyle = fillColor;
      ctx.textBaseline = "top";

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const clipChar = clipMask[idx];
          if (clipChar > 0) {
            rowBuf[c] = String.fromCharCode(clipChar);
            continue;
          }
          const ambient = (colWave[c] + rowWave[r]) * 0.08 + 0.1;
          const intensity = Math.max(trail[idx] ?? 0, ambient * 0.45);
          rowBuf[c] = toGlyph(intensity);
        }
        ctx.fillText(rowBuf.join(""), 0, r * charH);
      }
    }

    function syncLoop() {
      const canRender = cols > 0 && rows > 0;
      if (motionMedia.matches) {
        if (loopActive) {
          loopActive = false;
          if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        if (canRender) drawStaticFrame();
        return;
      }

      if (!isVisible || !canRender) {
        if (loopActive) {
          loopActive = false;
          if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        return;
      }

      if (!loopActive) {
        loopActive = true;
        lastRenderAt = 0;
        frameRef.current = requestAnimationFrame(step);
      }
    }

    const observer = new ResizeObserver(() => {
      syncCanvasSize();
      measureCharSize();
      rebuildGrid();
      fillColor = resolveColor(canvas);
      syncLoop();
    });
    observer.observe(wrap);

    const onVisibilityChange = () => {
      isVisible = document.visibilityState !== "hidden";
      syncLoop();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const onMotionChange = () => {
      syncLoop();
    };
    motionMedia.addEventListener("change", onMotionChange);

    syncCanvasSize();
    measureCharSize();
    rebuildGrid();
    fillColor = resolveColor(canvas);
    syncLoop();

    return () => {
      loopActive = false;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      motionMedia.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <div ref={wrapRef} className="w-full h-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block text-muted-foreground/60 select-none"
        aria-hidden="true"
      />
    </div>
  );
}
