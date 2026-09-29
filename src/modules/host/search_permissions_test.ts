import { deepStrictEqual as eq, rejects } from "node:assert/strict";
import { applicationRequest, type ApplicationServices } from "./application.ts";

Deno.test("search replacements require read permission as well as write permission", async () => {
  // Given an available backend whose dispatch is observable.
  let dispatched = 0;
  const service: ApplicationServices = {
    methods: () => ["search.replace"],
    request: () => {
      dispatched++;
      return Promise.resolve({ files: [] });
    },
  };
  const signal = new AbortController().signal;
  const replace = {
    method: "search.replace",
    parameters: { search: "owned-search", resultIds: ["one"], skipPaths: [] },
  };
  // When a module has write permission but cannot read the search snapshots.
  await rejects(() =>
    applicationRequest(service, "test.search", new Set(["files.write"]), replace, signal),
    /files.read/
  );
  const discovery = await applicationRequest(
    service, "test.search", new Set(["files.write"]),
    { method: "app.describe", parameters: {} }, signal,
  );
  // Then discovery and dispatch enforce the same capability boundary.
  eq(discovery, { version: 1, methods: [] });
  eq(dispatched, 0);
  await applicationRequest(
    service, "test.search", new Set(["files.write", "files.read"]), replace, signal,
  );
  eq(dispatched, 1);
});
