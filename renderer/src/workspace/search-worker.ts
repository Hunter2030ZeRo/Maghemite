import { searchDrafts, type SearchOptions, type SearchSnapshot } from "./search-text.ts";

declare const self: Pick<Worker, "onmessage" | "postMessage">;
export type DraftSearchReply =
  | { type: "started" }
  | { type: "result"; result: ReturnType<typeof searchDrafts> }
  | { type: "error"; error: string };

self.onmessage = ({ data }: MessageEvent<{
  documents: SearchSnapshot[];
  options: SearchOptions;
}>) => {
  self.postMessage({ type: "started" } satisfies DraftSearchReply);
  try {
    self.postMessage({
      type: "result", result: searchDrafts(data.documents, data.options),
    } satisfies DraftSearchReply);
  } catch (error) {
    self.postMessage({
      type: "error", error: error instanceof Error ? error.message : String(error),
    } satisfies DraftSearchReply);
  }
};
