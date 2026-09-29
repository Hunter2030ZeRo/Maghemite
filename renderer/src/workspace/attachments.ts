import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import {
  ATTACHMENT_LIMIT,
  attachmentDestination,
  AttachmentError,
  attachmentMarkdown,
  validAttachmentPath,
} from "./attachments_paths.ts";
export {
  ATTACHMENT_LIMIT,
  attachmentDestination,
  AttachmentError,
  attachmentMarkdown,
} from "./attachments_paths.ts";

const WRITE_CHUNK_BYTES = 16 * 1024;
export const ATTACHMENT_MEMORY_LIMIT = 64 * 1024 * 1024;
const retainedUrls = new Map<string, number>();
const memoryChanges = new EventTarget();
let retainedBytes = 0;

export function attachmentMemoryBytes() { return retainedBytes; }
export function retainAttachmentUrl(blob: Blob, path: string) {
  if (retainedBytes + blob.size > ATTACHMENT_MEMORY_LIMIT) {
    throw new AttachmentError("The app's 64 MiB attachment preview budget is full.", path);
  }
  const url = URL.createObjectURL(blob);
  retainedUrls.set(url, blob.size);
  retainedBytes += blob.size;
  memoryChanges.dispatchEvent(new Event("change"));
  return url;
}
export function releaseAttachmentUrl(url: string) {
  const size = retainedUrls.get(url);
  if (size === undefined) return;
  retainedUrls.delete(url);
  retainedBytes -= size;
  URL.revokeObjectURL(url);
  memoryChanges.dispatchEvent(new Event("change"));
}

/** One in-flight report, with newer cache changes coalesced into the next report. */
export function createAttachmentResourceReporter(
  send: (method: string, parameters: Json) => Promise<Json>,
  failed: (error: unknown) => void,
) {
  let active = false, dirty = false, generation = 0;
  let flight: Promise<void> | undefined;
  function flush(): Promise<void> {
    if (flight) return flight;
    if (!active || !dirty) return Promise.resolve();
    const own = generation;
    flight = (async () => {
      while (active && dirty && own === generation) {
        dirty = false;
        try {
          await send("modules.rendererResources", {
            attachmentBytes: retainedBytes,
            attachmentLimitBytes: ATTACHMENT_MEMORY_LIMIT,
          });
        } catch (error) {
          if (active && own === generation) failed(error);
          return;
        }
      }
    })().finally(() => {
      flight = undefined;
      if (active && dirty) void flush();
    });
    return flight;
  }
  const changed = () => { dirty = true; void flush(); };
  return {
    async start() {
      if (!active) {
        active = true;
        generation++;
        memoryChanges.addEventListener("change", changed);
      }
      changed();
      while (flight) await flight;
    },
    stop() {
      active = false;
      dirty = false;
      generation++;
      memoryChanges.removeEventListener("change", changed);
    },
  };
}

const imageTypes = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type AttachmentInput = {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type Request = (method: string, parameters: Json) => Promise<Json>;

function mimeType(path: string): string | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension && Object.hasOwn(imageTypes, extension)
    ? imageTypes[extension as keyof typeof imageTypes]
    : undefined;
}

function decodeBase64(data: string, path: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(data);
  } catch (cause) {
    throw new AttachmentError("Attachment data is not valid base64.", path, {
      cause,
    });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function createAttachments(request: Request) {
  const files = createAppAPI(request).files;

  async function readBlob(path: string, preview: boolean, signal?: AbortSignal): Promise<Blob> {
    if (!validAttachmentPath(path)) {
      throw new AttachmentError("Attachment path is not workspace-relative.", path);
    }
    const type = preview ? mimeType(path) : "application/octet-stream";
    if (!type) {
      throw new AttachmentError(
        "Preview supports local PNG, JPEG, GIF, WebP, and AVIF images.",
        path,
      );
    }
    let offset = 0;
    let expectedSize: number | undefined;
    let version: string | undefined;
    const chunks: ArrayBuffer[] = [];
    for (;;) {
      signal?.throwIfAborted();
      const page = await files.read({
        path,
        offset,
        ...(version ? { version } : {}),
      });
      signal?.throwIfAborted();
      if (expectedSize === undefined) {
        expectedSize = page.size;
        version = page.version;
        if (expectedSize > ATTACHMENT_LIMIT) {
          throw new AttachmentError(
            `Attachment exceeds the ${ATTACHMENT_LIMIT / 1024 / 1024} MiB preview limit.`,
            path,
          );
        }
      }
      if (page.version !== version || page.size !== expectedSize) {
        throw new AttachmentError("Attachment changed while it was being read.", path);
      }
      const bytes = decodeBase64(page.data, path);
      if (offset + bytes.length > expectedSize) {
        throw new AttachmentError("Attachment read exceeded its declared size.", path);
      }
      chunks.push(bytes.buffer);
      if (page.nextOffset === null) {
        if (offset + bytes.length !== expectedSize) {
          throw new AttachmentError("Attachment read ended before the file was complete.", path);
        }
        return new Blob(chunks, { type });
      }
      if (
        page.nextOffset <= offset || page.nextOffset !== offset + bytes.length
      ) {
        throw new AttachmentError("Attachment service returned an invalid offset.", path);
      }
      offset = page.nextOffset;
    }
  }

  async function ensureDirectory(path: string): Promise<void> {
    try {
      await files.mkdir({ path });
    } catch (cause) {
      let statFailure: unknown;
      try {
        const stat = await files.stat({ path });
        if (stat.kind === "directory") return;
      } catch (error) {
        statFailure = error;
      }
      throw new AttachmentError(
        `Could not create the attachment folder.${
          statFailure === undefined ? "" : ` ${String(statFailure)}`
        }`,
        path,
        { cause },
      );
    }
  }

  async function upload(
    notePath: string,
    input: AttachmentInput,
    signal?: AbortSignal,
  ): Promise<{
    readonly path: string;
    readonly target: string;
    readonly markdown: string;
  }> {
    const destination = attachmentDestination(notePath, input.name);
    if (input.size > ATTACHMENT_LIMIT) {
      throw new AttachmentError(
        `Attachment exceeds the ${ATTACHMENT_LIMIT / 1024 / 1024} MiB upload limit.`,
        destination.path,
      );
    }
    signal?.throwIfAborted();
    await ensureDirectory(destination.directory);
    const bytes = new Uint8Array(await input.arrayBuffer());
    if (bytes.length !== input.size || bytes.length > ATTACHMENT_LIMIT) {
      throw new AttachmentError("Attachment size changed before upload.", destination.path);
    }
    let upload: string | undefined;
    try {
      signal?.throwIfAborted();
      upload = (await files.beginWrite({
        path: destination.path,
        version: null,
      })).upload;
      for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
        signal?.throwIfAborted();
        const end = Math.min(offset + WRITE_CHUNK_BYTES, bytes.length);
        const result = await files.writeChunk({
          upload,
          offset,
          data: encodeBase64(bytes.subarray(offset, end)),
        });
        if (result.offset !== end) {
          throw new AttachmentError(
            "Attachment service returned an invalid write offset.",
            destination.path,
          );
        }
      }
      signal?.throwIfAborted();
      const committed = await files.commitWrite({ upload });
      upload = undefined;
      if (committed.size !== bytes.length) {
        throw new AttachmentError(
          "Attachment service committed an unexpected size.",
          destination.path,
        );
      }
      return {
        path: destination.path,
        target: destination.target,
        markdown: attachmentMarkdown(input.name, destination.target, input.type),
      };
    } catch (cause) {
      if (upload) {
        try {
          await files.abortWrite({ upload });
        } catch (abortCause) {
          throw new AttachmentError(
            `Upload failed and staged cleanup also failed: ${String(cause)}; ${String(abortCause)}`,
            destination.path,
            { cause },
          );
        }
      }
      throw cause instanceof AttachmentError
        ? cause
        : new AttachmentError(
          `Could not upload attachment without overwriting an existing file. ${String(cause)}`,
          destination.path,
          { cause },
        );
    }
  }

  return {
    read: (path: string, signal?: AbortSignal) => readBlob(path, true, signal),
    download: (path: string, signal?: AbortSignal) => readBlob(path, false, signal),
    upload,
  };
}
