import { ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { fixture } from "../core/services/search_fixture.ts";
import { DesktopApplication } from "./application.ts";

Deno.test("closing workbenches releases retained search handles before the next connection", async () => {
  const f = await fixture();
  try {
    // Given one native workspace shared by successive workbench lifetimes.
    await Deno.writeTextFile(join(f.root, "a.txt"), "needle");
    const searches = new Set<string>();
    // When more lifetimes than the global handle quota each start and close a search.
    for (let index = 0; index < 12; index++) {
      const application = new DesktopApplication(f.service);
      try {
        const result = await application.workbench("search.start", {
          workspaceId: await application.workspaceIdentity(), query: "needle",
        }, AbortSignal.timeout(5000));
        ok(result && typeof result === "object" && !Array.isArray(result));
        ok(typeof result.search === "string");
        searches.add(result.search);
      } finally {
        application.close();
        await application.settle();
      }
    }
    // Then every new workbench obtained a distinct usable handle without leaking old quotas.
    ok(searches.size === 12);
  } finally {
    await f.close();
  }
});

Deno.test("workbench file subscriptions are permission bounded and released at close", async () => {
  const f = await fixture();
  try {
    // Given successive connections, more than one owner's subscription quota.
    for (let index = 0; index < 12; index++) {
      const application = new DesktopApplication(f.service);
      const workspaceId = await application.workspaceIdentity();
      const signal = AbortSignal.timeout(5000);
      try {
        // When the trusted UI subscribes to file events but not unrelated settings.
        const result = await application.workbench("events.subscribe", {
          workspaceId, topics: ["files.changed"],
        }, signal);
        ok(result && typeof result === "object" && !Array.isArray(result));
        ok(typeof result.subscription === "string");
        await rejects(() => application.workbench("events.subscribe", {
          workspaceId, topics: ["settings.changed"],
        }, signal), /permission denied/);
      } finally {
        application.close();
        await application.settle();
      }
    }
    // Then all lifetimes completed without retaining any earlier quota slots.
  } finally {
    await f.close();
  }
});
