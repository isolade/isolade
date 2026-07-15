import { describe, expect, it } from "bun:test";
import {
  canonicalPrUrl,
  ghPrViewCommand,
  parseGhPrView,
  parsePrUrl,
  parseRepoUrl,
  resolvePrRef,
} from "../src/pr-attachments";

describe("parseRepoUrl", () => {
  it("parses scp-like SSH remotes", () => {
    expect(parseRepoUrl("git@github.com:acme/isolade.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
    });
  });

  it("parses https remotes with and without .git", () => {
    expect(parseRepoUrl("https://github.com/acme/isolade.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
    });
    expect(parseRepoUrl("https://github.com/acme/isolade")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
    });
  });

  it("parses ssh:// remotes and Enterprise hosts", () => {
    expect(parseRepoUrl("ssh://git@ghe.example.com/acme/widgets.git")).toEqual({
      host: "ghe.example.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("returns null for non-repo URLs", () => {
    expect(parseRepoUrl("https://github.com/acme")).toBeNull();
    expect(parseRepoUrl("not a url")).toBeNull();
    expect(parseRepoUrl("")).toBeNull();
  });
});

describe("parsePrUrl", () => {
  it("parses a full PR web URL", () => {
    expect(parsePrUrl("https://github.com/acme/isolade/pull/123")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
      number: 123,
    });
  });

  it("tolerates a trailing slash and a missing scheme", () => {
    expect(parsePrUrl("github.com/acme/isolade/pull/7/")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
      number: 7,
    });
  });

  it("returns null for a repo URL without a PR number", () => {
    expect(parsePrUrl("https://github.com/acme/isolade")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/isolade/pull/abc")).toBeNull();
  });
});

describe("resolvePrRef", () => {
  it("resolves a number against a remote URL", () => {
    expect(resolvePrRef({ number: 42, remoteUrl: "git@github.com:acme/isolade.git" })).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
      number: 42,
    });
  });

  it("resolves a full PR URL, ignoring the number", () => {
    expect(resolvePrRef({ prUrl: "https://github.com/acme/isolade/pull/9" })).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "isolade",
      number: 9,
    });
  });

  it("errors on a missing remote", () => {
    const r = resolvePrRef({ number: 1 });
    expect("error" in r).toBe(true);
  });

  it("errors on a bad number and a bad remote", () => {
    expect("error" in resolvePrRef({ number: 0, remoteUrl: "git@github.com:a/b.git" })).toBe(true);
    expect("error" in resolvePrRef({ number: 1, remoteUrl: "nonsense" })).toBe(true);
    expect("error" in resolvePrRef({ prUrl: "https://github.com/a/b" })).toBe(true);
  });
});

describe("canonicalPrUrl", () => {
  it("builds the web URL", () => {
    expect(canonicalPrUrl({ host: "github.com", owner: "a", repo: "b", number: 5 })).toBe(
      "https://github.com/a/b/pull/5",
    );
  });
});

describe("ghPrViewCommand", () => {
  it("drops the host prefix for github.com", () => {
    expect(ghPrViewCommand({ host: "github.com", owner: "a", repo: "b", number: 3 })).toBe(
      "gh pr view 3 --repo 'a/b' --json number,title,state,isDraft,url",
    );
  });

  it("keeps the host prefix for Enterprise", () => {
    expect(ghPrViewCommand({ host: "ghe.example.com", owner: "a", repo: "b", number: 3 })).toBe(
      "gh pr view 3 --repo 'ghe.example.com/a/b' --json number,title,state,isDraft,url",
    );
  });
});

describe("parseGhPrView", () => {
  it("maps gh states to our lowercase enum", () => {
    expect(
      parseGhPrView('{"number":1,"title":"T","state":"OPEN","isDraft":false,"url":"u"}'),
    ).toEqual({ title: "T", state: "open", isDraft: false, url: "u" });
    expect(parseGhPrView('{"title":"T","state":"MERGED"}')?.state).toBe("merged");
    expect(parseGhPrView('{"title":"T","state":"CLOSED"}')?.state).toBe("closed");
  });

  it("carries the draft flag", () => {
    expect(parseGhPrView('{"title":"T","state":"OPEN","isDraft":true}')?.isDraft).toBe(true);
  });

  it("returns null for gh errors / unparseable output", () => {
    expect(parseGhPrView("")).toBeNull();
    expect(parseGhPrView("could not find pull request")).toBeNull();
    // A shape with no recognizable state and no title is unusable.
    expect(parseGhPrView("{}")).toBeNull();
  });
});
