import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const browserDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(browserDir, "../..");
const require = createRequire(import.meta.url);

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/lib\/render-metrics$/,
        replacement: path.resolve(browserDir, "harness/render-metrics.ts"),
      },
      {
        find: "react-markdown-uninstrumented",
        replacement: require.resolve("react-markdown"),
      },
      {
        find: /^react-markdown$/,
        replacement: path.resolve(browserDir, "harness/instrumented-react-markdown.tsx"),
      },
      { find: "@", replacement: path.resolve(webRoot, "src") },
    ],
  },
});
