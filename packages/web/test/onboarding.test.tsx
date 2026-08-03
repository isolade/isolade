import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import OnboardingWizard, {
  BuildStep,
  ChooserStep,
  CustomStep,
  DockerfileStep,
  SignInAction,
  STEPS,
} from "../src/components/OnboardingWizard";
import { shouldSelfOpen } from "../src/lib/useOnboarding";

// The guided setup. What is worth pinning is the shape of a run: the
// same four steps every time, a choice before any questions, and a card that
// only puts itself on screen when there is nothing to work with.

describe("the card", () => {
  it("opens straight onto the choice", () => {
    // Nothing is resolved up front, because nothing exists yet: the profile is
    // created once the run knows what it is making.
    const html = renderToStaticMarkup(<OnboardingWizard onClose={() => {}} />);
    expect(html).toContain("The Excalidraw demo");
    expect(html).toContain("Step 1 of 4");
  });

  it("always runs the same four steps, in the same order", () => {
    // The Dockerfile is read before the build is of it, since an edit afterwards
    // costs a second build. Sign-in boots a VM from a built image, so it cannot
    // precede the build, and a profile the wizard just created is never already
    // signed in. One shape for every run.
    expect(STEPS).toEqual(["branch", "dockerfile", "build", "signin"]);
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

  it("groups what it offers, since a list this long does not scan flat", () => {
    expect(html).toContain("Languages and runtimes");
    expect(html).toContain("Databases");
    expect(html).toContain("Command line");
  });

  it("offers a base to build on", () => {
    expect(html).toContain("Ubuntu 24.04");
    expect(html).toContain("Debian 13");
  });

  it("asks its questions without the file they compose", () => {
    // The Dockerfile has a step of its own now, so this screen is questions only
    // rather than questions beside a preview of the answer.
    expect(html).not.toContain("FROM ubuntu:24.04");
    expect(html).toContain("Write the Dockerfile");
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

describe("the Dockerfile step", () => {
  const html = renderToStaticMarkup(
    <DockerfileStep value={"FROM ubuntu:24.04\nRUN apt-get update\n"} onChange={() => {}} />,
  );

  it("shows the file, highlighted the way Settings shows it", () => {
    // The same CodeEditor, so the tokens carry the same `hljs-` classes as the
    // Dockerfile section and the chat's code blocks.
    expect(html).toContain("FROM ubuntu:24.04");
    expect(html).toContain("hljs-");
  });

  it("lets it be edited before anything is built", () => {
    // A build has not run yet at this point, so a change here costs nothing,
    // where the same change after the build costs another one.
    expect(html).toContain("<textarea");
    expect(html).not.toContain("readonly");
  });

  it("says where the file lives afterwards", () => {
    expect(html).toContain("Settings, Dockerfile");
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
  const html = renderToStaticMarkup(<BuildStep profileId="p1" />);

  it("shows the build output rather than only its outcome", () => {
    // Watching it is the difference between a wait and a hang, and on a failure
    // it is the only thing that says what went wrong.
    expect(html).toContain("Waiting for output…");
  });

  it("says the wait is expected, and that leaving does not stop it", () => {
    expect(html).toContain("first build is the slow one");
    expect(html).toContain("closing this card does not stop it");
  });

  it("offers nothing that closes the card, since the card has that", () => {
    // It used to end in "Leave this running", which closed the card, directly
    // above the Close that also closes it.
    expect(html).not.toContain("Leave this running");
    expect(html).not.toContain("<button");
  });
});

describe("the way on from the build", () => {
  it("is there from the start, and waits for a build that worked", () => {
    // In the card's footer rather than in the step, so the wait does not reserve
    // a row for a button that only appears at the end of it.
    expect(renderToStaticMarkup(<SignInAction ready={false} onDone={() => {}} />)).toContain(
      'disabled=""',
    );
    expect(renderToStaticMarkup(<SignInAction ready onDone={() => {}} />)).not.toContain(
      'disabled=""',
    );
  });
});

describe("the card's controls", () => {
  it("keeps them in one row at the bottom", () => {
    // Close on the first step, Close and the way on from the build. Never two
    // buttons that do the same thing.
    const html = renderToStaticMarkup(<OnboardingWizard onClose={() => {}} />);
    expect(html.match(/Close/g)).toHaveLength(1);
    expect(html).not.toContain("Sign in<");
  });
});
