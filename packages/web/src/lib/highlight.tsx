// Shared syntax-highlighting engine (lowlight → highlight.js). Colours come from
// the `.hljs-*` token CSS in index.css (GitHub palette, light + dark). Used by
// the chat/diff renderers (line-by-line) and the environment editor (whole-file
// Dockerfile + raw TOML).

import dockerfile from "highlight.js/lib/languages/dockerfile";
import { common, createLowlight } from "lowlight";
import { Fragment, type ReactNode } from "react";

const lowlight = createLowlight(common);
// Not in the `common` set: register Dockerfile, and alias TOML to the ini
// grammar (highlight.js ships no dedicated TOML language, and ini is a close
// fit), and lowlight resolves the alias in `registered()` and `highlight()`.
lowlight.register("dockerfile", dockerfile);
lowlight.registerAlias({ ini: ["toml"] });

// Minimal hast shape, since lowlight returns text nodes and <span> elements whose
// className is the list of hljs token classes.
type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: string[] | string };
  children?: HastNode[];
};

function renderNode(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const raw = node.properties?.className;
    const className = Array.isArray(raw) ? raw.join(" ") : raw;
    return (
      <span key={key} className={className}>
        {(node.children ?? []).map(renderNode)}
      </span>
    );
  }
  return null;
}

function isLanguageRegistered(language: string): boolean {
  return lowlight.registered(language);
}

// Highlight one line, resuming no state from neighbours (used by the diff view,
// which only has the lines inside each hunk). Falls back to raw text for unknown
// languages. An empty line renders a single space so the row keeps its height.
export function highlightLine(text: string, language: string | null): ReactNode {
  if (!text) return " ";
  if (!language || !isLanguageRegistered(language)) return text;
  try {
    const tree = lowlight.highlight(language, text) as unknown as HastNode;
    return <Fragment>{(tree.children ?? []).map(renderNode)}</Fragment>;
  } catch {
    return text;
  }
}

// Highlight a whole document at once, so multi-line constructs (block strings,
// continuations) colour correctly. Falls back to raw text for unknown languages.
export function highlightCode(code: string, language: string): ReactNode {
  if (!isLanguageRegistered(language)) return code;
  try {
    const tree = lowlight.highlight(language, code) as unknown as HastNode;
    return <Fragment>{(tree.children ?? []).map(renderNode)}</Fragment>;
  } catch {
    return code;
  }
}
