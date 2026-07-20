import type { RefObject } from "react";
import type { StreamChunk } from "@/components/chat/chunks";
import {
  MessageHistory,
  type MessageHistoryHandle,
  type SessionMessageRow,
} from "@/components/chat/MessageHistory";
import type { TranscriptMessage } from "@/lib/contracts";
import type { HarnessPage } from "./fixtures";

export interface HarnessLiveRow {
  renderKey: string;
  message: TranscriptMessage;
  chunks: StreamChunk[];
  streaming: boolean;
}

interface RendererAdapterProps {
  pages: HarnessPage[];
  sessionRows: SessionMessageRow[];
  live: HarnessLiveRow | null;
  historyRef: RefObject<MessageHistoryHandle | null>;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
}

const ignoreMessage = (_id: string) => {};
const ignoreEdit = (_id: string, _content: string) => {};
const ignoreNavigation = (_id: string, _direction: 1 | -1) => {};
const ignore = () => {};

export function RendererAdapter({
  pages,
  sessionRows,
  live,
  historyRef,
  scrollElementRef,
  visible,
}: RendererAdapterProps) {
  return (
    <MessageHistory
      ref={historyRef}
      instanceId="renderer-harness"
      pages={pages}
      sessionRows={sessionRows}
      live={live}
      scrollElementRef={scrollElementRef}
      showDebug={false}
      userFontFamily="ui-sans-serif, system-ui, sans-serif"
      agentFontFamily="ui-sans-serif, system-ui, sans-serif"
      editingId={null}
      actionsDisabled={false}
      visible={visible}
      hasOlder={false}
      onStartEdit={ignoreMessage}
      onCancelEdit={ignore}
      onSubmitEdit={ignoreEdit}
      onNavigateVersion={ignoreNavigation}
      onRequestToolDetails={ignoreMessage}
      onLoadOlder={ignore}
      onLayoutChange={ignore}
    />
  );
}
