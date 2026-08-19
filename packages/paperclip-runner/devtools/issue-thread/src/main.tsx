import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./issue-thread.css";

// `?capture=1` freezes animation, caret, and smooth scrolling so the
// screenshot matrix is byte-stable across runs (contract §10.1).
const params = new URLSearchParams(window.location.search);
const hashQuery = window.location.hash.split("?")[1] ?? "";
if (params.get("capture") === "1" || new URLSearchParams(hashQuery).get("capture") === "1") {
  document.documentElement.dataset.capture = "true";
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Capability issue-thread root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
