// Writing to the clipboard from a webview. The async clipboard API is the
// happy path; a hidden textarea covers the webviews that deny it (Tauri's
// WebKitGTK does, without a permission prompt), so a copy button is never a
// dead button. Returns whether the text made it, so callers can hold back
// their "copied" confirmation when it did not.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // best effort, nothing more we can do in a locked-down webview
  }
  document.body.removeChild(ta);
  return copied;
}
