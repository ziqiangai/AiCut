import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "./Router.js";
import { ToastProvider } from "./Toast.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Router />
    </ToastProvider>
  </StrictMode>,
);
