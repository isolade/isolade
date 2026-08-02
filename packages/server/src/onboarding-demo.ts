import type { ProfileConfigForm, RuntimeConfig } from "@isolade/shared";

// The demo profile the onboarding wizard can install, so someone can watch an
// agent work without first authoring anything.
//
// excalidraw is the repository because it is visual. Isolade has a browser
// preview and a ports panel, and excalidraw running in that preview turns "an
// agent edited a file" into "the drawing tool in front of you changed", which no
// amount of terminal output achieves. It is also MIT licensed, actively
// maintained, and conventional to build.
//
// This lives as code rather than as a data file because the server ships as a
// compiled single-file binary, so a file on disk beside it is not a thing that
// exists at runtime. Same reasoning as the guest-side scripts in the sandbox
// package, which are template strings for the same reason.

export const DEMO_PROFILE_NAME = "Excalidraw";

export const DEMO_REPO_NAME = "excalidraw";

/**
 * Unlike the scaffolds in `onboarding.ts`, this installs dependencies at build
 * time. The reasoning differs because the situation does: a scaffold faces a
 * repository nobody has tested this against, where an install step is the
 * likeliest thing to fail, whereas this definition is one we own. Paying for it
 * once in a build the wizard already warns is slow buys instances that boot with
 * `node_modules` present, and avoids a network failure landing in the middle of
 * the demo rather than before it.
 *
 * Yarn's cache is a cache mount, so a rebuild re-uses the download.
 */
export const DEMO_DOCKERFILE = `# syntax=docker/dockerfile:1
# The excalidraw demo environment. Yours to edit like any other profile.
FROM node:22

WORKDIR /workspace/${DEMO_REPO_NAME}
COPY --from=${DEMO_REPO_NAME} . .

# Dependencies are installed here rather than on first boot, so an instance
# starts with a working tree ready to run. The cache mount means a rebuild
# re-uses the download instead of fetching the tree again.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \\
    yarn install --frozen-lockfile --network-timeout 600000
`;

export const DEMO_CONFIG_FORM: ProfileConfigForm = {
  repos: [
    {
      name: DEMO_REPO_NAME,
      source: "https://github.com/excalidraw/excalidraw",
      branch: "master",
    },
  ],
  dockerfile: "./Dockerfile",
  skills: [],
};

/**
 * The dev server runs from the async start phase, so an instance comes up with
 * port 3000 listening and the ports panel offering it as a one-click preview,
 * rather than the agent having to think of starting it. Async because a dev
 * server never exits, so a sync entry would hold the instance at boot forever.
 *
 * BROWSER=none because Vite's config sets `open: true`, and inside a VM there is
 * no browser to open, which otherwise puts a failure in the logs on every boot.
 */
export const DEMO_RUNTIME_CONFIG: RuntimeConfig = {
  caches: [],
  setup: { sync: [], async: [] },
  start: {
    sync: [],
    async: [`cd /workspace/${DEMO_REPO_NAME} && BROWSER=none yarn start`],
  },
};
