import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentStrip } from "@/components/chat/AttachmentStrip";
import { MessageBox } from "@/components/MessageBox";
import { ModelEffortPicker } from "@/components/ModelEffortPicker";
import { beaconDeleteInstance, createInstance, deleteInstance } from "../../lib/api";
import {
  type ChatEffort,
  type ChatModelDefinition,
  clampEffortToModel,
  DEFAULT_ANTHROPIC_MODEL_ID,
  findChatModel,
  type Instance,
  type ModelOverrides,
  splitModelsByTier,
} from "../../lib/contracts";
import { useAttachments } from "../../lib/use-attachments";

const MODEL_STORAGE_KEY = "isolade.lastModelId";
const EFFORT_STORAGE_KEY = "isolade.lastEffort";

function readStoredModelId(): string | null {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoredEffort(): ChatEffort | null {
  try {
    // Any non-empty string is a valid effort; the drafter clamps it to the
    // chosen model's supported set (clampEffortToModel) before it's used.
    return window.localStorage.getItem(EFFORT_STORAGE_KEY) || null;
  } catch {}
  return null;
}

interface NewInstancePaneProps {
  profileId: string | null;
  chatModels: ChatModelDefinition[];
  /** Per-profile visibility/tier overrides applied to `chatModels`. */
  modelOverrides: ModelOverrides;
  defaultModelId: string;
  onSubmit: (params: {
    instancePromise: Promise<Instance>;
    modelId: string;
    effort: ChatEffort;
    firstMessage: string;
    uploadIds: string[];
  }) => void;
}

export default function NewInstancePane({
  profileId,
  chatModels,
  modelOverrides,
  defaultModelId,
  onSubmit,
}: NewInstancePaneProps) {
  const [input, setInput] = useState("");
  const [modelId, setModelId] = useState(() => readStoredModelId() ?? defaultModelId);
  const modelDef = useMemo(
    () => chatModels.find((m) => m.id === modelId) ?? findChatModel(modelId),
    [chatModels, modelId],
  );
  const [effort, setEffort] = useState<ChatEffort>(
    () => readStoredEffort() ?? modelDef?.defaultEffort ?? "high",
  );
  // Persist only deliberate picker selections. Automatic snapping (effort
  // clamp on model change, catalog-fallback model swap) shouldn't overwrite
  // the user's last explicit choice.
  const handlePickModel = useCallback((next: string) => {
    setModelId(next);
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, next);
    } catch {}
  }, []);
  const handlePickEffort = useCallback((next: ChatEffort) => {
    setEffort(next);
    try {
      window.localStorage.setItem(EFFORT_STORAGE_KEY, next);
    } catch {}
  }, []);
  // No server in the loop yet. When the user picks a model whose effort
  // menu doesn't include the current value, snap to that model's default.
  // (Counterpart for mid-chat lives on the server's PATCH route.)
  useEffect(() => {
    if (!modelDef) return;
    setEffort((prev) => clampEffortToModel(prev, modelDef));
  }, [modelDef]);
  // Snap to a visible model when the current selection isn't offered — the
  // catalog hasn't loaded the stored id yet, or the profile has hidden it.
  // Prefer the default Claude model, then any frontier model, so the picker
  // always reflects something the server will accept.
  useEffect(() => {
    if (chatModels.length === 0) return;
    const { frontier, more } = splitModelsByTier(chatModels, modelOverrides);
    const visible = [...frontier, ...more];
    if (visible.some((m) => m.id === modelId)) return;
    const fallback = visible.find((m) => m.id === DEFAULT_ANTHROPIC_MODEL_ID) ?? visible[0];
    if (fallback) setModelId(fallback.id);
  }, [chatModels, modelOverrides, modelId]);
  const spawnPromiseRef = useRef<Promise<Instance> | null>(null);
  const pendingInstanceIdRef = useRef<string | null>(null);
  const submittedRef = useRef(false);

  // Eager spawn fires invisibly on the first keystroke so the VM has a head
  // start by the time the user submits. The pane's visible chrome stays
  // identical whether or not a spawn is in flight.
  const fireSpawn = useCallback(() => {
    if (spawnPromiseRef.current) return;
    if (!profileId) return;
    const promise = createInstance({ profile: profileId });
    spawnPromiseRef.current = promise;
    promise
      .then((instance) => {
        pendingInstanceIdRef.current = instance.id;
        return instance;
      })
      .catch(() => {
        // Swallow here. Resubmission via handleSubmit re-fires and surfaces
        // the error to the parent's creating-view state.
        spawnPromiseRef.current = null;
      });
  }, [profileId]);

  // Attachments in the empty-state pane need an instance to upload against, but
  // one only exists once the eager spawn lands. This resolver nudges the spawn
  // and awaits its id, so attaching a file (or pasting one) transparently
  // brings the VM up. The uploads are staged against the same instance the
  // submit later hands to the parent, so their ids stay valid for the send.
  const resolveInstanceId = useCallback(async (): Promise<string | null> => {
    if (!spawnPromiseRef.current) fireSpawn();
    const instance = await spawnPromiseRef.current;
    return instance?.id ?? null;
  }, [fireSpawn]);
  const attachments = useAttachments(resolveInstanceId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cleanupPending = useCallback(() => {
    const id = pendingInstanceIdRef.current;
    pendingInstanceIdRef.current = null;
    if (id) {
      void deleteInstance(id).catch(() => {});
      spawnPromiseRef.current = null;
      return;
    }
    // No id yet, createInstance is still in flight. Chain a delete onto
    // the resolution so the VM that lands on the server *after* we've
    // unmounted doesn't leak as an invisible untitled instance.
    const promise = spawnPromiseRef.current;
    spawnPromiseRef.current = null;
    if (!promise) return;
    void promise.then((instance) => deleteInstance(instance.id).catch(() => {})).catch(() => {});
  }, []);

  useEffect(() => {
    const handler = () => {
      if (submittedRef.current) return;
      const id = pendingInstanceIdRef.current;
      if (id) beaconDeleteInstance(id);
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    return () => {
      if (submittedRef.current) return;
      cleanupPending();
    };
  }, [cleanupPending]);

  const handleSubmit = async () => {
    const content = input.trim();
    // Await any in-flight uploads first. A submit is allowed with empty text as
    // long as there's at least one attachment.
    const uploads = await attachments.resolveUploads();
    const uploadIds = uploads.map((u) => u.id);
    if (!content && uploadIds.length === 0) return;
    if (!spawnPromiseRef.current) fireSpawn();
    const promise = spawnPromiseRef.current;
    if (!promise) return;
    submittedRef.current = true;
    onSubmit({
      instancePromise: promise,
      modelId,
      effort,
      firstMessage: content,
      uploadIds,
    });
  };

  // Pull image (and any file) blobs out of a paste and stage them.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    attachments.add(files);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 pb-12">
      <div className="w-full max-w-2xl flex flex-col gap-3">
        <h1 className="text-center text-2xl font-medium text-foreground/90 mb-4">
          What do you want to do?
        </h1>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              attachments.add(Array.from(e.target.files));
            }
            e.target.value = "";
          }}
        />
        <MessageBox
          autoFocus
          value={input}
          onChange={(next) => {
            const wasEmpty = input.length === 0;
            setInput(next);
            if (wasEmpty && next.length > 0) fireSpawn();
          }}
          onSubmit={() => void handleSubmit()}
          placeholder="Ask anything…"
          onAttachClick={() => fileInputRef.current?.click()}
          onPaste={handlePaste}
          hasAttachments={attachments.items.length > 0}
          attachments={<AttachmentStrip items={attachments.items} onRemove={attachments.remove} />}
          leftToolbar={
            <ModelEffortPicker
              models={chatModels}
              overrides={modelOverrides}
              currentModelId={modelId}
              currentEffort={effort}
              onModelChange={handlePickModel}
              onEffortChange={handlePickEffort}
            />
          }
        />
      </div>
    </div>
  );
}
