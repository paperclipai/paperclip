import { createRoot } from "react-dom/client";
import { App } from "./harness.js";

const container = document.getElementById("root");
if (!container) throw new Error("No #root in harness host");
createRoot(container).render(<App />);
