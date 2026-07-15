import type { PortStatus } from "./contracts";

export type PortStatusValue = PortStatus["status"];

// Status → colored status dot. `undefined` means the first probe hasn't landed
// yet, so we render a neutral tone rather than flashing red.
export function portStatusDotClass(status: PortStatusValue | undefined): string {
  switch (status) {
    case "listening":
      return "bg-emerald-500";
    case "not-listening":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/40";
  }
}

// Human-readable explanation of a port's reachability, used for tooltips and
// the preview's warning banner.
export function portStatusLabel(status: PortStatusValue | undefined): string {
  switch (status) {
    case "listening":
      return "Listening, reachable via forward";
    case "not-listening":
      return "Nothing is listening inside the VM on this port";
    default:
      return "Probing…";
  }
}
