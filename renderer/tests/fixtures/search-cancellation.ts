import { searchDraftsAsync } from "../../src/workspace/search-async.ts";

declare const self: Pick<Worker, "onmessage" | "postMessage">;
const controller = new AbortController();
self.onmessage = async ({ data }: MessageEvent<"start" | "cancel">) => {
  if (data === "cancel") {
    controller.abort();
    return;
  }
  try {
    await searchDraftsAsync([{
      id: "regex.txt", path: "regex.txt", version: "v1",
      content: "a".repeat(64) + "!",
    }], { query: "^(a+)+$", regex: true }, controller.signal, () => {
      self.postMessage("started");
    });
    self.postMessage("completed");
  } catch (error) {
    self.postMessage(
      error instanceof DOMException && error.name === "AbortError"
        ? "cancelled"
        : String(error),
    );
  }
};
