import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled into the app (SIL Open Font License); nothing is fetched at runtime.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import { App } from "./App";
import "./tokens.css";
import "./styles.css";
import "./projects.css";
import "./plan.css";
import "./locations.css";
import "./produce.css";
import "./results.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
