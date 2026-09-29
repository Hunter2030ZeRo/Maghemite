import {
  SearchError,
  type searchDrafts,
  type SearchOptions,
  type SearchSnapshot,
} from "./search-text.ts";
import type { DraftSearchReply } from "./search-worker.ts";

export async function searchDraftsAsync(
  documents: readonly SearchSnapshot[],
  options: SearchOptions,
  signal: AbortSignal,
  started?: () => void,
) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ReturnType<typeof searchDrafts>>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true, signal: lifetime.signal,
      });
      timer = setTimeout(() => reject(
        new SearchError("Draft search exceeded 5 seconds. Simplify the expression."),
      ), 5000);
      worker.onmessage = ({ data }: MessageEvent<DraftSearchReply>) => {
        if (data.type === "started") started?.();
        else if (data.type === "result") resolve(data.result);
        else reject(new SearchError(data.error));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new SearchError(event.message));
      };
      worker.postMessage({ documents, options });
    });
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    worker.terminate();
  }
}
