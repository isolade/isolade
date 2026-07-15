import { describe, expect, it } from "bun:test";
import { classifyListeningPorts, parseListeningPorts } from "../src/instances";

// /proc/net/tcp rows: `sl  local_address rem_address st ...`. local_address is
// HEXADDR:HEXPORT, st 0A = LISTEN. IPv4 addr is little-endian hex, so
// 0.0.0.0 = 00000000 and 127.0.0.1 = 0100007F. Port is big-endian hex:
// 5173 = 0x1435, 8080 = 0x1F90, 3000 = 0x0BB8.
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue";

function tcp(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

describe("classifyListeningPorts", () => {
  it("reports any listener as listening, so loopback binds count too", () => {
    const v4 = tcp([
      "   0: 00000000:1435 00000000:0000 0A 00000000:00000000", // 0.0.0.0:5173 LISTEN
      "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000", // 127.0.0.1:8080 LISTEN
    ]);
    const out = classifyListeningPorts(`${v4}\n---\n${HEADER}`, [5173, 8080, 3000]);
    // Loopback (8080) is reachable through the in-guest relay, so it's
    // "listening" just like the wildcard bind, with no more loopback-only footgun.
    expect(out).toEqual([
      { remotePort: 5173, status: "listening" },
      { remotePort: 8080, status: "listening" },
      { remotePort: 3000, status: "not-listening" },
    ]);
  });

  it("ignores non-LISTEN sockets (e.g. an established connection)", () => {
    // state 01 = ESTABLISHED, a client connection to :3000, not a listener.
    const v4 = tcp(["   0: 00000000:0BB8 0100007F:abcd 01 00000000:00000000"]);
    const out = classifyListeningPorts(`${v4}\n---\n${HEADER}`, [3000]);
    expect(out).toEqual([{ remotePort: 3000, status: "not-listening" }]);
  });

  it("detects IPv6 wildcard (::) listeners", () => {
    const v6Row =
      "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A";
    const out = classifyListeningPorts(`${HEADER}\n---\n${HEADER}\n${v6Row}`, [8080]);
    expect(out).toEqual([{ remotePort: 8080, status: "listening" }]);
  });

  it("returns an empty array for no requested ports", () => {
    expect(classifyListeningPorts(`${HEADER}\n---\n${HEADER}`, [])).toEqual([]);
  });
});

describe("parseListeningPorts", () => {
  it("collects every LISTEN port across v4 + v6, wildcard or loopback", () => {
    const v4 = tcp([
      "   0: 00000000:1435 00000000:0000 0A 00000000:00000000", // 0.0.0.0:5173
      "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000", // 127.0.0.1:8080
      "   2: 00000000:0BB8 0100007F:abcd 01 00000000:00000000", // :3000 ESTABLISHED, skip
    ]);
    const v6 = `${HEADER}\n   0: 00000000000000000000000001000000:0035 00000000000000000000000000000000:0000 0A`; // [::1]:53
    const ports = parseListeningPorts(`${v4}\n---\n${v6}`);
    expect([...ports].toSorted((a, b) => a - b)).toEqual([53, 5173, 8080]);
  });

  it("returns an empty set when nothing is listening", () => {
    expect(parseListeningPorts(`${HEADER}\n---\n${HEADER}`).size).toBe(0);
  });
});
