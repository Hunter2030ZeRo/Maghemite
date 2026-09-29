import { deepStrictEqual as eq, ok, rejects } from "node:assert/strict";
import { createInstallations } from "../src/workspace/installations.ts";
import type { InstallationSnapshot } from "../../src/shared/module_installations.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
import { InstallationNotAcceptedError } from "../src/workspace/modules.ts";

function operation(id: string, phase: InstallationSnapshot["phase"], revision = 1): InstallationSnapshot {
  return {
    id, moduleId: "test.installation", kind: "install", phase, revision,
    completedTargets: phase === "succeeded" ? 2 : 0, totalTargets: 2,
    committed: phase === "succeeded", error: null,
  };
}

Deno.test("lost acceptance retains the client UUID and exact input until authoritative reconnect", async () => {
  const sent: Json[] = [];
  let disconnected = true;
  const installations = createInstallations((_method, parameters) => {
    sent.push(structuredClone(parameters));
    if (disconnected) return Promise.reject(new Error("disconnected"));
    ok(parameters && typeof parameters === "object" && !Array.isArray(parameters));
    ok(typeof parameters.operationId === "string");
    return Promise.resolve(operation(parameters.operationId, "preparing"));
  });
  await installations.start("modules.install", { token: "review", grants: ["wasm.execute"] });
  const id = installations.unconfirmed()?.parameters.operationId;
  ok(id && /^[a-f0-9-]{36}$/.test(id));
  disconnected = false;
  await installations.resume();
  eq(sent[0], sent[1]);
  eq(installations.state().activeOperation?.id, id);
  eq(installations.unconfirmed(), undefined);
  eq(installations.state().outcomes, []);
});

Deno.test("committed recovery cannot regress to delayed acceptance or cancellation responses", async () => {
  const response = Promise.withResolvers<Json>();
  const installations = createInstallations(() => response.promise);
  const accepting = installations.start("modules.install", { token: "review", grants: [] });
  const id = installations.unconfirmed()?.parameters.operationId;
  ok(id);
  const authoritative = { ...operation(id, "succeeded", 5), error: "Recovery needed" };
  installations.receive({ activeOperation: null, outcomes: [authoritative], maintenance: [] });
  response.resolve(operation(id, "queued"));
  await accepting;
  installations.update(operation(id, "preparing", 2));
  installations.receive({ activeOperation: operation(id, "committing", 4), outcomes: [], maintenance: [] });
  eq(installations.state().activeOperation, null);
  eq(installations.state().outcomes, [authoritative]);
  eq(installations.error(), "");
  eq(installations.unconfirmed(), undefined);
});

Deno.test("unmount aborts the exact status subscription without cancelling its application job", async () => {
  const calls: string[] = [], subscribed = Promise.withResolvers<AbortSignal>();
  const installations = createInstallations((method, _parameters, signal) => {
    calls.push(method);
    ok(signal);
    subscribed.resolve(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const active = operation(crypto.randomUUID(), "preparing", 2);
  installations.receive({ activeOperation: active, outcomes: [], maintenance: [] });
  const view = new AbortController();
  const observing = installations.observe(active.id, view.signal);
  const abortSignal = await subscribed.promise;
  const aborted = rejects(observing, /Abort/);
  view.abort();
  await aborted;
  eq(abortSignal.aborted, true);
  eq(calls, ["modules.installationStatus"]);
  eq(installations.state().activeOperation, active);
});

Deno.test("a delayed old acceptance finalizer does not own a newer installation identity", async () => {
  const first = Promise.withResolvers<Json>(), second = Promise.withResolvers<Json>();
  let requests = 0;
  const installations = createInstallations(() => ++requests === 1 ? first.promise : second.promise);
  const a = installations.start("modules.install", { token: "first", grants: [] });
  const aId = installations.unconfirmed()?.parameters.operationId;
  ok(aId);
  installations.receive({ activeOperation: null, outcomes: [operation(aId, "succeeded", 5)], maintenance: [] });
  const b = installations.start("modules.install", { token: "second", grants: [] });
  const bId = installations.unconfirmed()?.parameters.operationId;
  ok(bId && bId !== aId);
  eq(requests, 2);
  first.resolve(operation(aId, "queued"));
  await a;
  eq(installations.unconfirmed()?.parameters.operationId, bId);
  second.resolve(operation(bId, "queued"));
  await b;
  eq(installations.state().activeOperation?.id, bId);
});

Deno.test("authoritative rejection permits a new review without retaining a dead identity", async () => {
  const installations = createInstallations(() =>
    Promise.reject(new InstallationNotAcceptedError("Review expired")));
  await installations.start("modules.install", { token: "expired", grants: [] });
  eq(installations.unconfirmed(), undefined);
  ok(installations.error());
  await installations.start("modules.install", { token: "fresh", grants: [] });
  eq(installations.unconfirmed(), undefined);
});
