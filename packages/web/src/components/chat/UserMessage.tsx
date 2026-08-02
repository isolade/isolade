import { CircleAlert, Paperclip, Pencil } from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Upload } from "@/lib/contracts";
import { useAttachments } from "@/lib/use-attachments";
import { cn } from "@/lib/utils";
import { AttachmentStrip } from "./AttachmentStrip";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageUploads } from "./MessageUploads";

export interface UserMessageModel {
  id: string;
  content: string;
  uploads?: Upload[];
  deliveryStatus?: "sending" | "confirmed" | "unknown" | "rejected" | null;
}

export interface UserMessageCapabilities {
  edit?: boolean;
}

function UserMessageEditor({
  message,
  instanceId,
  fontFamily,
  onCancel,
  onSubmit,
}: {
  message: UserMessageModel;
  instanceId: string;
  fontFamily: string;
  onCancel: () => void;
  onSubmit: (content: string, uploads: Upload[]) => void;
}) {
  const [draft, setDraft] = useState(message.content);
  const [submitting, setSubmitting] = useState(false);
  const attachments = useAttachments(instanceId, message.uploads ?? []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const maxHeight = Math.min(window.innerHeight * 0.5, 480);
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
  }, [draft]);

  const canSubmit =
    draft.trim().length > 0 || attachments.items.some((item) => item.status !== "error");
  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const uploads = await attachments.resolveUploads();
    if (!draft.trim() && uploads.length === 0) {
      setSubmitting(false);
      return;
    }
    onSubmit(draft, uploads);
  };

  return (
    <div className="w-full rounded-2xl border border-input bg-secondary px-4 py-2.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (files.length === 0) return;
          event.preventDefault();
          attachments.add(files);
        }}
        rows={1}
        className="w-full resize-none bg-transparent text-sm leading-relaxed text-secondary-foreground outline-none"
        style={{ fontFamily }}
      />
      {attachments.items.length > 0 && (
        <div className="mt-2">
          <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              attachments.add(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Add attachment"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 rounded-full"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-full"
            disabled={!canSubmit || submitting}
            onClick={() => void submit()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// One presentation for ordinary and in-turn user messages. Callers describe
// capabilities instead of choosing markup, so future styling and actions stay
// shared while provider-specific limitations remain explicit.
export const UserMessage = memo(function UserMessage({
  message,
  capabilities,
  instanceId,
  fontFamily,
  inline = false,
  editing = false,
  actionsDisabled = false,
  footer,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UserMessageModel;
  capabilities: UserMessageCapabilities;
  instanceId: string;
  fontFamily: string;
  inline?: boolean;
  editing?: boolean;
  actionsDisabled?: boolean;
  footer?: ReactNode;
  onStartEdit?: (id: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (id: string, content: string, uploads: Upload[]) => void;
}) {
  const editable =
    capabilities.edit === true &&
    onStartEdit !== undefined &&
    onCancelEdit !== undefined &&
    onSubmitEdit !== undefined;
  // What the user wrote, verbatim. A message that is only attachments has
  // nothing to put on the clipboard.
  const copyable = message.content.length > 0;
  const body = (
    <div
      className={cn(
        "group/message flex flex-col items-end gap-1",
        editing ? "w-full" : "max-w-[80%]",
      )}
    >
      {editing && editable ? (
        <UserMessageEditor
          message={message}
          instanceId={instanceId}
          fontFamily={fontFamily}
          onCancel={onCancelEdit}
          onSubmit={(content, uploads) => onSubmitEdit(message.id, content, uploads)}
        />
      ) : (
        <>
          {message.content && (
            <div
              className="whitespace-pre-wrap break-words rounded-2xl bg-secondary px-4 py-2.5 text-sm text-secondary-foreground"
              style={{ fontFamily }}
            >
              {message.content}
            </div>
          )}
          {message.uploads && message.uploads.length > 0 && (
            <MessageUploads instanceId={instanceId} uploads={message.uploads} />
          )}
          {(message.deliveryStatus === "unknown" || message.deliveryStatus === "rejected") && (
            <div role="status" className="flex items-center gap-1 text-xs text-destructive">
              <CircleAlert className="size-3.5" aria-hidden="true" />
              {message.deliveryStatus === "unknown"
                ? "Message may not have been sent"
                : "Message was not sent"}
            </div>
          )}
          {(copyable || editable || footer) && (
            <div className="flex h-6 items-center">
              {copyable && (
                <MessageCopyButton
                  text={message.content}
                  className="group-hover/message:opacity-100"
                />
              )}
              {editable && (
                <div className="flex items-center" data-chat-action>
                  <button
                    type="button"
                    aria-label="Edit message"
                    data-disabled-at-rest="false"
                    disabled={actionsDisabled}
                    onClick={() => onStartEdit(message.id)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/message:opacity-100 disabled:pointer-events-none disabled:opacity-0"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {footer}
            </div>
          )}
        </>
      )}
    </div>
  );

  // Assistant rows reserve right-side reading space. Cancel it here so an
  // in-turn bubble shares the right edge and width of an ordinary user row.
  return inline ? (
    <div
      className="-mr-12 my-4 flex justify-end"
      data-in-turn-user-message={message.id}
      data-steered-user-message={message.id}
    >
      {body}
    </div>
  ) : (
    body
  );
});
