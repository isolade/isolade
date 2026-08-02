import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import OnboardingWizard, {
  BuildStep,
  ChooserStep,
  CustomStep,
  STEPS,
} from "../src/components/OnboardingWizard";
import { shouldSelfOpen } from "../src/lib/useOnboarding";

// The guided setup. What is worth pinning is the shape of a run: the
// same three steps every time, a choice before any questions, and a card that
// only puts itself on screen when there is nothing to work with.

describe("the card", () => {
  it("opens straight onto the choice", () => {
    // Nothing is resolved up front, because nothing exists yet: the profile is
    // created once the run knows what it is making.
    const html = renderToStaticMarkup(<OnboardingWizard onClose={() => {}} />);
    expect(html).toContain("The Excalidraw demo");
    expect(html).toContain("Step 1 of 3");
  });

  it("always runs the same three steps, in the same order", () => {
    // Sign-in boots a VM from a built image, so it cannot precede the build, and
    // a profile the wizard just created is never already signed in. One shape
    // for every run.
    expect(STEPS).toEqual(["branch", "build", "signin"]);
  });
});

describe("the choice", () => {
  const html = renderToStaticMarkup(<ChooserStep onCreated={() => {}} onCustom={() => {}} />);

  it("offers the demo and your own code, and asks nothing else yet", () => {
    expect(html).toContain("The Excalidraw demo");
    expect(html).toContain("Your own code");
    expect(html).not.toContain("Your repositories");
  });
});

describe("setting up your own", () => {
  const html = renderToStaticMarkup(<CustomStep onCreated={() => {}} onBack={() => {}} />);

  it("asks for a name, repositories, and what the image should carry", () => {
    expect(html).toContain("Profile name");
    expect(html).toContain("Your repositories");
    expect(html).toContain("What should the image have?");
    expect(html).toContain("Python");
  });

  it("offers a base to build on", () => {
    expect(html).toContain("Ubuntu 24.04");
    expect(html).toContain("Debian 13");
  });

  it("shows the Dockerfile it would write, before writing it", () => {
    // The preview sits beside the questions, so the file is something the user
    // has read once by the time it is theirs to edit.
    expect(html).toContain("FROM ubuntu:24.04");
  });

  it("requires nothing: an empty workspace is a valid profile", () => {
    expect(html).not.toContain('disabled=""');
  });

  it("offers no toolchain the agent layer already installs", () => {
    // Node arrives in every image, so offering it would suggest a choice that
    // does not exist.
    expect(html).not.toContain(">Node<");
  });
});

describe("opening itself", () => {
  it("opens on an install with nothing to work with", () => {
    expect(shouldSelfOpen({ hasUsableProfile: false, dismissed: false })).toBe(true);
  });

  it("stays away once a profile has a build definition", () => {
    expect(shouldSelfOpen({ hasUsableProfile: true, dismissed: false })).toBe(false);
  });

  it("opens for someone who signed in and got no further", () => {
    // Credentials live under the data dir and profiles under the config dir, so
    // an install can be signed in with nothing to work with. Signing in is also
    // step one of doing this by hand, and hiding from that person hides from
    // exactly who the flow is for.
    expect(shouldSelfOpen({ hasUsableProfile: false, dismissed: false })).toBe(true);
  });

  it("never nags after a dismissal", () => {
    expect(shouldSelfOpen({ hasUsableProfile: false, dismissed: true })).toBe(false);
  });
});

describe("the build step", () => {
  // Rendered directly, since reaching it through the card needs a real build.
  const html = renderToStaticMarkup(
    <BuildStep profileId="p1" onDone={() => {}} onClose={() => {}} />,
  );

  it("shows the build output rather than only its outcome", () => {
    // Watching it is the difference between a wait and a hang, and on a failure
    // it is the only thing that says what went wrong.
    expect(html).toContain("Waiting for output…");
  });

  it("says the wait is expected, and that leaving does not stop it", () => {
    expect(html).toContain("first build is the slow one");
    expect(html).toContain("Leave this running");
  });
});
