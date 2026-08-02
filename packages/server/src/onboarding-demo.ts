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

/** Uid the demo's agent user takes. Fixed rather than left to `useradd`, so the
 *  yarn cache mount below can be owned by it: BuildKit gives a cache mount to
 *  root unless told otherwise, and the install runs as the agent. 1001 because
 *  `node:22` already has `node` at 1000. */
const DEMO_AGENT_UID = 1001;

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
 *
 * The agent user is created here rather than left to the agent layer, because
 * only a Dockerfile that has one can `COPY --chown` and install as it. The
 * alternative is a tree and a `node_modules` owned by root, which the agent
 * cannot edit and Vite cannot write its cache into, so the demo would build and
 * then fail at the thing it exists to show.
 */
export const DEMO_DOCKERFILE = `# syntax=docker/dockerfile:1
# The excalidraw demo environment. Yours to edit like any other profile.
FROM node:22

# The user the agent runs as. It owns the checkout and everything installed into
# it, so an agent can edit the source and the dev server can write its caches.
# The directory is made here rather than left to WORKDIR, which would create it
# owned by root and leave yarn unable to write node_modules into it.
RUN useradd --uid ${DEMO_AGENT_UID} --user-group --create-home --shell /bin/bash agent \\
    && mkdir -p /workspace/${DEMO_REPO_NAME} \\
    && chown agent:agent /workspace /workspace/${DEMO_REPO_NAME}

WORKDIR /workspace/${DEMO_REPO_NAME}
COPY --from=${DEMO_REPO_NAME} --chown=agent:agent . .

USER agent

# Dependencies are installed here rather than on first boot, so an instance
# starts with a working tree ready to run. The cache mount means a rebuild
# re-uses the download instead of fetching the tree again.
RUN --mount=type=cache,target=/home/agent/.cache/yarn,uid=${DEMO_AGENT_UID},gid=${DEMO_AGENT_UID} \\
    yarn install --frozen-lockfile --network-timeout 600000 \\
        --cache-folder /home/agent/.cache/yarn
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
