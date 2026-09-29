import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { RecoveryStore } from "./recovery.ts";
import { defaultLayout, documentFromText } from "../shared/workspace.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
const workspace = "a".repeat(64), signal = new AbortController().signal;
const snapshot = () =>
  JSON.stringify({
    version: 1,
    documents: [documentFromText("notes/a.md", "한글😀".repeat(10000))],
    tabs: [],
    activeTab: null,
    mode: "knowledge",
    layout: defaultLayout,
  });
async function upload(
  store: RecoveryStore,
  text: string,
  revision: string | null,
) {
  const { transfer } = await store.request(workspace, "recovery.begin", {
    revision,
  }, signal) as { transfer: string };
  for (let offset = 0; offset < text.length; offset += 4096) {
    await store.request(workspace, "recovery.chunk", {
      transfer,
      offset,
      text: text.slice(offset, offset + 4096),
    }, signal);
  }
  return { transfer };
}
Deno.test("host recovery is atomic, chunked, persistent and workspace isolated", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let store = new RecoveryStore(dir);
    const text = snapshot();
    const upload1 = await upload(store, text, null);
    const result = await store.request(
      workspace,
      "recovery.commit",
      upload1,
      signal,
    ) as { revision: string };
    store = new RecoveryStore(dir);
    const start = await store.request(
      workspace,
      "recovery.open",
      {},
      signal,
    ) as { transfer: string; revision: string };
    eq(start.revision, result.revision);
    let restored = "", offset = 0;
    for (;;) {
      const page = await store.request(workspace, "recovery.read", {
        transfer: start.transfer,
        offset,
      }, signal) as { text: string; nextOffset: number | null };
      restored += page.text;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    eq(restored, text);
    eq(await store.request("b".repeat(64), "recovery.open", {}, signal), {
      revision: null,
      transfer: null,
    });
    const stale = await upload(store, text, null);
    await rejects(
      () => store.request(workspace, "recovery.commit", stale, signal),
      /changed elsewhere/,
    );
    const invalid = await upload(store, "{}", result.revision);
    await rejects(
      () => store.request(workspace, "recovery.commit", invalid, signal),
      /Invalid workspace/,
    );
    ok(
      (await Deno.readTextFile(`${dir}/recovery/${workspace}.json`)).includes(
        result.revision,
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test("recovery rejects invalid chunks, traversal, cross-workspace commits and cancelled writes", async () => {
  const dir = await Deno.makeTempDir(), store = new RecoveryStore(dir);
  try {
    const begin = await store.request(workspace, "recovery.begin", {
      revision: null,
    }, signal) as { [key: string]: Json };
    await rejects(
      () =>
        store.request(workspace, "recovery.chunk", {
          ...begin,
          offset: 1,
          text: "a",
        }, signal),
      /Invalid recovery chunk/,
    );
    await rejects(
      () => store.request("..", "recovery.open", {}, signal),
      /Invalid recovery workspace/,
    );
    await rejects(
      () => store.request("b".repeat(64), "recovery.commit", begin, signal),
      /expired/,
    );
    const valid = await upload(store, snapshot(), null);
    await rejects(() =>
      store.request(workspace, "recovery.commit", valid, AbortSignal.abort())
    );
    eq(await store.request(workspace, "recovery.open", {}, signal), {
      revision: null,
      transfer: null,
    });
    store.resetTransfers();
    await rejects(
      () => store.request(workspace, "recovery.commit", valid, signal),
      /expired/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
