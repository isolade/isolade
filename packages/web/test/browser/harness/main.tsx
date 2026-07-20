import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { getRenderMetrics } from "./metrics";
import { ProductionChatHarness } from "./ProductionChatHarness";
import { RendererHarness } from "./RendererHarness";

getRenderMetrics();

const Harness =
  new URLSearchParams(window.location.search).get("production") === "1"
    ? ProductionChatHarness
    : RendererHarness;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
