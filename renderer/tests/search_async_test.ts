import { deepStrictEqual as eq, rejects } from "node:assert/strict";
import { searchDraftsAsync } from "../src/workspace/search-async.ts";

Deno.test("draft search cancellation interrupts a running backtracking expression", async () => {
  // Keep this harness responsive even if matching regresses to synchronous work.
  const worker = new Worker(new URL("./fixtures/search-cancellation.ts", import.meta.url), {
    type: "module",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Running draft search did not cancel")), 10000);
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        if (data === "started") worker.postMessage("cancel");
        else resolve(data);
      };
    });
    worker.postMessage("start");
    eq(await result, "cancelled");
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
});

Deno.test("draft search Worker preserves ranges and replacement previews", async () => {
  const result = await searchDraftsAsync([{
    id: "a.md", path: "a.md", version: "v1", content: "😀\r\nitem42",
  }], { query: "(item)([0-9]+)", regex: true, replacement: "$1-$2" }, new AbortController().signal);
  eq(result.matches.map(({ from, to, line, column, replacement }) =>
    ({ from, to, line, column, replacement })
  ), [{ from: 4, to: 10, line: 2, column: 0, replacement: "item-42" }]);
  eq(result.truncated, false);
});

Deno.test("draft search rejects pre-cancelled requests and invalid expressions", async () => {
  await rejects(
    searchDraftsAsync([], { query: "x" }, AbortSignal.abort()),
    { name: "AbortError" },
  );
  await rejects(
    searchDraftsAsync([], { query: "[", regex: true }, new AbortController().signal),
    /Invalid search expression/,
  );
});

Deno.test("draft search enforces its execution deadline without user cancellation", async () => {
  await rejects(
    searchDraftsAsync([{
      id: "a", path: "a", version: "v1", content: "a".repeat(64) + "!",
    }], { query: "^(a+)+$", regex: true }, new AbortController().signal),
    /exceeded 5 seconds/,
  );
});
