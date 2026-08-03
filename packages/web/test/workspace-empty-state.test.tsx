import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NoProfile,
  ProfileUnbuilt,
  ServerOffline,
} from "../src/components/home/WorkspaceEmptyState";
import type { ProfileSummary } from "../src/lib/contracts";

// What stands in for the composer when a message typed into one could not go
// anywhere. Each of these replaces a case that used to accept the message and
// then answer with an internal precondition.

function profile(over: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: "excalidraw",
    name: "Excalidraw",
    image: null,
    status: "pending",
    errorMessage: null,
    hasConfig: true,
    configPath: "/config/isolade/profiles/excalidraw/config.toml",
    createdAt: new Date(0),
    ...over,
  };
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("no server", () => {
  const html = render(<ServerOffline />);

  it("names the server rather than the request that happened to fail", () => {
    expect(html).toContain("Waiting for the Isolade server");
  });

  it("says it is being retried, since the window recovers on its own", () => {
    expect(html).toContain("retried");
  });
});

describe("no profile", () => {
  const html = render(<NoProfile onOpenWizard={() => {}} />);

  it("offers the one way out", () => {
    expect(html).toContain("No environment yet");
    expect(html).toContain("Guided setup");
  });
});

describe("a profile with nothing built", () => {
  it("says a build is running, and where to watch it", () => {
    const html = render(
      <ProfileUnbuilt
        profile={profile({ status: "building" })}
        building={false}
        onWatchBuild={() => {}}
        onBuild={() => {}}
      />,
    );
    expect(html).toContain("Building Excalidraw");
    expect(html).toContain("Watch the build");
  });

  it("reports a failed build instead of letting a chat be typed at it", () => {
    // This is the screen someone lands on by closing guided setup while its
    // build runs, and it used to be a composer answering "profile excalidraw
    // has no built image yet" to the first message.
    const html = render(
      <ProfileUnbuilt
        profile={profile({ status: "error", errorMessage: "step 3 failed" })}
        building={false}
        onWatchBuild={() => {}}
        onBuild={() => {}}
      />,
    );
    expect(html).toContain("has not been built");
    expect(html).toContain("Open the build log");
  });

  it("offers to build one that never has been", () => {
    const html = render(
      <ProfileUnbuilt
        profile={profile()}
        building={false}
        onWatchBuild={() => {}}
        onBuild={() => {}}
      />,
    );
    expect(html).toContain("Build it");
    expect(html).not.toContain('disabled=""');
  });

  it("disables that button while the build is being kicked off", () => {
    const html = render(
      <ProfileUnbuilt
        profile={profile()}
        building={true}
        onWatchBuild={() => {}}
        onBuild={() => {}}
      />,
    );
    expect(html).toContain('disabled=""');
  });
});
