import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBox } from "../src/components/MessageBox";

function render(props: Partial<Parameters<typeof MessageBox>[0]> = {}) {
  return renderToStaticMarkup(
    <MessageBox
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      onAttachClick={() => {}}
      modelPicker={<span>PICKER</span>}
      status={<span>STATUS</span>}
      {...props}
    />,
  );
}

// MessageBox owns where the bottom row's pieces sit so that the new-chat draft
// box and every chat pane read identically. These are the positions, asserted
// here rather than trusted to each call site.
describe("MessageBox bottom row", () => {
  it("puts the attach button and model picker on the left, status in the send corner", () => {
    const html = render();
    const attach = html.indexOf('aria-label="Attach files"');
    const picker = html.indexOf("PICKER");
    const sendCorner = html.indexOf("ml-auto");
    const status = html.indexOf("STATUS");
    const send = html.indexOf('aria-label="Send"');
    expect(attach).toBeGreaterThan(-1);
    expect(attach).toBeLessThan(picker);
    expect(picker).toBeLessThan(sendCorner);
    expect(sendCorner).toBeLessThan(status);
    expect(status).toBeLessThan(send);
  });

  // The send corner holds one button, so the status has to keep its place
  // whichever of them is showing rather than being positioned against either.
  it("keeps the status ahead of Stop while a turn runs on an empty composer", () => {
    const html = render({ loading: true, onStop: () => {} });
    const status = html.indexOf("STATUS");
    const stop = html.indexOf('aria-label="Stop"');
    expect(stop).toBeGreaterThan(-1);
    expect(html).not.toContain('aria-label="Queue message"');
    expect(status).toBeLessThan(stop);
  });

  it("keeps the status ahead of the button once a draft turns it into Queue", () => {
    const html = render({ loading: true, onStop: () => {}, value: "a draft" });
    const status = html.indexOf("STATUS");
    const queue = html.indexOf('aria-label="Queue message"');
    expect(queue).toBeGreaterThan(-1);
    expect(html).not.toContain('aria-label="Stop"');
    expect(status).toBeLessThan(queue);
  });
});
