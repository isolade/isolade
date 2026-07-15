import { MACOS_WINDOW_INSET, TRAFFIC_LIGHT, TRAFFIC_LIGHT_GAP } from "../lib/tauri";

interface TrafficLightsProps {
  isTauri: boolean;
}

// The macOS window-controls slot at the top-left of the title bar. Vertical
// position is owned by the title bar (it centres its children), so this only
// holds the horizontal slot.
//
// In Tauri the real OS traffic lights are painted by the system (see
// app/src/lib.rs traffic_light_position), so here we render only an invisible
// spacer that reserves their width, keeping whatever follows clear of the
// native lights. The web build has no OS chrome, so we draw decorative Big Sur
// look-alike dots in the same slot to mirror the desktop app.
export default function TrafficLights({ isTauri }: TrafficLightsProps) {
  return (
    <div
      className="h-full inline-flex items-center"
      aria-hidden
      data-demo="window-lights"
      style={{
        visibility: isTauri ? "hidden" : "visible",
        gap: TRAFFIC_LIGHT_GAP,
        marginLeft: TRAFFIC_LIGHT_GAP + MACOS_WINDOW_INSET,
        marginRight: 1 + TRAFFIC_LIGHT_GAP,
      }}
    >
      <span
        style={TRAFFIC_LIGHT}
        className="rounded-full bg-[#FF5F57] border border-[#E0443E]/60"
      />
      <span
        style={TRAFFIC_LIGHT}
        className="rounded-full bg-[#FEBC2E] border border-[#DEA123]/60"
      />
      <span
        style={TRAFFIC_LIGHT}
        className="rounded-full bg-[#28C840] border border-[#1AAB29]/60"
      />
    </div>
  );
}
