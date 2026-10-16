import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "@/index.css";

export function mountApp(rootElement: HTMLElement | null): void {
  if (!rootElement) {
    return;
  }
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

if (typeof document !== "undefined") {
  mountApp(document.getElementById("root"));
}
