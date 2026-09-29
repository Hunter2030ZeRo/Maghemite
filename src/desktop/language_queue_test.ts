import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { LanguageQueue } from "./language_queue.ts";
const signal = new AbortController().signal;
Deno.test("language queue prioritizes latest interaction, preserves transactions and bounds background starvation", async () => {
  const queue = new LanguageQueue(), gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = queue.enqueue("first", false, signal, async () => {
    order.push("first");
    await gate.promise;
    return null;
  });
  const run = (key: string, interactive: boolean) =>
    queue.enqueue(key, interactive, signal, async () => {
      order.push(key);
      return key;
    });
  const background = run("tokens", false);
  const old = run("hover", true);
  const latest = run("hover", true);
  equal(await old, null);
  const more = Array.from(
    { length: 9 },
    (_, i) => run(`interactive${i}`, true),
  );
  gate.resolve();
  await Promise.all([first, background, latest, ...more]);
  deepStrictEqual(order.slice(0, 3), ["first", "hover", "interactive0"]);
  equal(order[9], "tokens");
  equal(order.filter((s) => s === "hover").length, 1);
});
Deno.test("language queue removes cancelled waiters and keeps serving after errors and clear", async () => {
  const queue = new LanguageQueue(), gate = Promise.withResolvers<void>();
  const first = queue.enqueue("first", false, signal, async () => {
    await gate.promise;
    throw Error("failed query");
  });
  const failed = rejects(first, /failed query/);
  const controller = new AbortController();
  const waiting = queue.enqueue("hover", true, controller.signal, async () => {
    throw Error("must not execute");
  });
  controller.abort();
  equal(await waiting, null);
  const cleared = queue.enqueue("tokens", false, signal, async () => {
    throw Error("must not execute");
  });
  queue.clear();
  equal(await cleared, null);
  gate.resolve();
  await failed;
  equal(await queue.enqueue("new", true, signal, async () => "ok"), "ok");
});
