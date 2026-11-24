const RAY_COUNT = 8;
const CLEANUP_MS = 700;
const SVG = "http://www.w3.org/2000/svg";

/** Plays the finish celebration over `anchor`. Decorative: styled in interaction-motion.css. */
export function playFinishBurst(anchor: Element) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const { left, top, width, height } = anchor.getBoundingClientRect();
  const burst = document.createElement("div");
  burst.dataset.finishBurst = "";
  burst.setAttribute("aria-hidden", "true");
  burst.style.left = `${left + width / 2}px`;
  burst.style.top = `${top + height / 2}px`;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  const check = document.createElementNS(SVG, "path");
  check.setAttribute("d", "M6 10.5l2.7 2.7 5.3-6");
  svg.append(check);
  burst.append(svg);
  for (let index = 0; index < RAY_COUNT; index += 1) {
    const ray = document.createElement("i");
    ray.style.setProperty("--ray-angle", `${(360 / RAY_COUNT) * index}deg`);
    burst.append(ray);
  }
  document.body.append(burst);
  window.setTimeout(() => burst.remove(), CLEANUP_MS);
}
