import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { getRenderMetrics } from "./metrics";
import { ProductionChatHarness } from "./ProductionChatHarness";
import { RendererHarness } from "./RendererHarness";
import { WorkspaceHarness } from "./WorkspaceHarness";

getRenderMetrics();

const parameters = new URLSearchParams(window.location.search);
const workspace = parameters.get("workspace") === "1";
const Harness = workspace
  ? WorkspaceHarness
  : parameters.get("production") === "1"
    ? ProductionChatHarness
    : RendererHarness;

// The workspace harness measures commit cost against the real component tree,
// so it opts out of StrictMode's double render rather than reporting numbers
// no production build would produce.
createRoot(document.getElementById("root")!).render(
  workspace ? (
    <Harness />
  ) : (
    <StrictMode>
      <Harness />
    </StrictMode>
  ),
);
