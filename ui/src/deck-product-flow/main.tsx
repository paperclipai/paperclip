import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DeckProductFlowHarness, type DeckProductFlowMode } from "./ProductFlowHarness";
import { clampDeckProductFlowFrame } from "./fixtures";
import "../index.css";

function readMode(value: string | null): DeckProductFlowMode {
  return value === "embed" ? "embed" : "capture";
}

function readFrame(value: string | null) {
  return clampDeckProductFlowFrame(Number(value ?? 0));
}

function applyTheme(value: string | null) {
  const theme = value === "light" ? "light" : "dark";
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

const params = new URLSearchParams(window.location.search);
applyTheme(params.get("theme"));

document.documentElement.dataset.register = "product";
document.documentElement.dataset.paperclipDeckHarness = "deck-product-flow";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DeckProductFlowHarness mode={readMode(params.get("mode"))} initialFrame={readFrame(params.get("frame"))} />
  </StrictMode>,
);
