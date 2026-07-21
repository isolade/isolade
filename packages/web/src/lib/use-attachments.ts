import { useCallback, useRef, useState } from "react";
import { uploadAttachment, uploadUrl } from "./api";
import type { Upload } from "./contracts";

// One staged attachment in the composer. `status` tracks the background upload:
// the file is uploaded as soon as it's added (so a preview and the server id
// are ready by send time), and `resolveUploadIds` waits out any still in
// flight. `previewUrl` is an object URL for images, revoked on removal.
export interface PendingAttachment {
  localId: string;
  filename: string;
  mediaType: string;
  size: number;
  previewUrl?: string;
  status: "uploading" | "done" | "error";
  uploadId?: string;
}

function isImage(type: string): boolean {
  return type.startsWith("image/");
}

// The instance to upload against. Either a known id (the chat view) or an async
// resolver (the new-chat pane, which only learns its id once the eager VM spawn
// lands). A resolver returning null means "no instance yet", which fails the
// upload cleanly.
export type InstanceIdSource = string | (() => Promise<string | null>);

// Owns the composer's attachment list plus the upload lifecycle for one
// instance. Files upload immediately on add; `resolveUploads` awaits the
// in-flight uploads and returns the metadata to put on the send body.
export function useAttachments(source: InstanceIdSource, initialUploads: Upload[] = []) {
  const [items, setItems] = useState<PendingAttachment[]>(() =>
    initialUploads.map((upload) => ({
      localId: upload.id,
      filename: upload.filename,
      mediaType: upload.mediaType,
      size: upload.size,
      previewUrl:
        isImage(upload.mediaType) && typeof source === "string"
          ? uploadUrl(source, upload.id)
          : undefined,
      status: "done",
      uploadId: upload.id,
    })),
  );
  // Authoritative mirror of `items` so async callbacks (uploads, resolve) read
  // the latest list without stale closures. Every mutation goes through `apply`.
  const itemsRef = useRef<PendingAttachment[]>(items);
  const uploads = useRef(new Map<string, Promise<void>>());

  const apply = useCallback((next: (prev: PendingAttachment[]) => PendingAttachment[]) => {
    itemsRef.current = next(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const add = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const localId = crypto.randomUUID();
        const filename = file.name || (isImage(file.type) ? "pasted-image" : "attachment");
        const item: PendingAttachment = {
          localId,
          filename,
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          previewUrl: isImage(file.type) ? URL.createObjectURL(file) : undefined,
          status: "uploading",
        };
        apply((prev) => [...prev, item]);
        // Resolve the instance lazily per file: in the new-chat pane this is
        // what nudges the eager spawn and waits for its id.
        const promise = Promise.resolve(typeof source === "function" ? source() : source)
          .then((instanceId) => {
            if (!instanceId) throw new Error("no instance to upload to");
            return uploadAttachment(instanceId, file, filename);
          })
          .then((upload) => {
            apply((prev) =>
              prev.map((it) =>
                it.localId === localId ? { ...it, status: "done", uploadId: upload.id } : it,
              ),
            );
          })
          .catch(() => {
            apply((prev) =>
              prev.map((it) => (it.localId === localId ? { ...it, status: "error" } : it)),
            );
          })
          .finally(() => {
            uploads.current.delete(localId);
          });
        uploads.current.set(localId, promise);
      }
    },
    [source, apply],
  );

  const remove = useCallback(
    (localId: string) => {
      uploads.current.delete(localId);
      apply((prev) => {
        const target = prev.find((it) => it.localId === localId);
        if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
        return prev.filter((it) => it.localId !== localId);
      });
    },
    [apply],
  );

  const clear = useCallback(() => {
    uploads.current.clear();
    apply((prev) => {
      for (const it of prev) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      return [];
    });
  }, [apply]);

  // Await every in-flight upload, then return the metadata of the ones that
  // landed, in list order. Failed uploads are dropped (their preview stays
  // until the user removes it, but they never make it into a send).
  const resolveUploads = useCallback(async (): Promise<Upload[]> => {
    await Promise.all([...uploads.current.values()]);
    return itemsRef.current
      .filter((it) => it.status === "done" && it.uploadId)
      .map((it) => ({
        id: it.uploadId as string,
        filename: it.filename,
        mediaType: it.mediaType,
        size: it.size,
      }));
  }, []);

  return { items, add, remove, clear, resolveUploads };
}
