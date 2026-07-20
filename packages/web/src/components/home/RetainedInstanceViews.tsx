import { memo } from "react";
import type { Chat, ChatModelDefinition, Instance, ModelOverrides } from "../../lib/contracts";
import InstanceView from "./InstanceView";

const EMPTY_CHATS: Chat[] = [];

interface RetainedInstanceViewsProps {
  instances: Instance[];
  chatsByInstance: ReadonlyMap<string, Chat[]>;
  activeInstanceId: string | null;
  pendingFirstMessage: { chatId: string; content: string; uploadIds?: string[] } | null;
  chatModels: ChatModelDefinition[];
  modelOverrides: ModelOverrides;
  onTitleAutoUpdated: (instanceId: string, title: string) => void;
  onResourceChange: (instanceId: string) => void;
}

/** Retains every live instance subtree while changing only pane visibility. */
function RetainedInstanceViews({
  instances,
  chatsByInstance,
  activeInstanceId,
  pendingFirstMessage,
  chatModels,
  modelOverrides,
  onTitleAutoUpdated,
  onResourceChange,
}: RetainedInstanceViewsProps) {
  return instances.map((instance) => {
    const isActive = activeInstanceId === instance.id;
    return (
      <div
        key={instance.id}
        data-retained-instance={instance.id}
        className="absolute inset-0 flex min-h-0"
        aria-hidden={!isActive}
        inert={!isActive}
        style={{
          contain: "strict",
          opacity: isActive ? 1 : 0,
          pointerEvents: isActive ? "auto" : "none",
        }}
      >
        <InstanceView
          instanceId={instance.id}
          chats={chatsByInstance.get(instance.id) ?? EMPTY_CHATS}
          chatModels={chatModels}
          modelOverrides={modelOverrides}
          visible={isActive}
          pendingFirstMessage={isActive ? pendingFirstMessage : null}
          pending={false}
          creationError={null}
          onTitleAutoUpdated={onTitleAutoUpdated}
          onResourceChange={onResourceChange}
        />
      </div>
    );
  });
}

export default memo(RetainedInstanceViews);
