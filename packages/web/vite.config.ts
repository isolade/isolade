import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: process.env.VITE_HOST ?? true,
    // Dev-server port. The browser flow (scripts/dev.sh) uses the default 5173,
    // a known URL to open. The native flow (scripts/app.sh, `bun run app`) picks
    // a random free port, sets ISOLADE_WEB_PORT, and overrides Tauri's devUrl to
    // match, so multiple app instances never collide on 5173.
    port: Number(process.env.ISOLADE_WEB_PORT) || 5173,
    // Bind exactly that port or fail loudly: a silent drift to another port
    // would leave Tauri's devUrl pointing at the wrong (or a stale) server.
    strictPort: true,
    proxy: {
      "/api": {
        // Defaults to the normal dev server. The demo recorder overrides this
        // (it runs the server on a rarely-used port to avoid clashes).
        target: process.env.ISOLADE_API_PROXY ?? "http://localhost:3000",
        ws: true,
      },
    },
  },
});
