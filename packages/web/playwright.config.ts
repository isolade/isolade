import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ISOLADE_RENDER_HARNESS_PORT ?? 4199);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    // Trace and video snapshots repeatedly walk the full retained DOM. Keep
    // that observer overhead out of these renderer behavior tests.
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      // GitHub's Ubuntu image already includes Chrome. Use it in CI instead
      // of downloading a second browser on every run. Local development keeps
      // Playwright's pinned Chromium for reproducibility.
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.CI ? { channel: "chrome" as const } : {}),
      },
    },
    ...(process.env.ISOLADE_TEST_WEBKIT === "1"
      ? [
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
          },
        ]
      : []),
  ],
  webServer: {
    command: `bunx vite --config test/browser/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/test/browser/harness/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
