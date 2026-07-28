import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/theme.css";
import "./styles/titlebar.css";
import "./styles/viewer.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("renderer root is unavailable");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
