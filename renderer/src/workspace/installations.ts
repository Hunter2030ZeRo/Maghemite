import { createSignal } from "solid-js";
import { InstallationNotAcceptedError } from "./modules.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import type {
  InstallationSnapshot,
  InstallationState,
} from "../../../src/shared/module_installations.ts";

export type InstallationRequest = (
  method: string,
  parameters: Json,
  signal?: AbortSignal,
) => Promise<Json>;

export function installationActive(snapshot: InstallationSnapshot): boolean {
  return snapshot.phase === "queued" || snapshot.phase === "preparing" ||
    snapshot.phase === "committing";
}

/** Workspace-owned identity; a mounted view owns only its status subscription. */
export function createInstallations(request: InstallationRequest) {
  const [state, setState] = createSignal<InstallationState>({
    activeOperation: null, outcomes: [], maintenance: [],
  });
  const [unconfirmed, setUnconfirmed] = createSignal<{
    method: string;
    parameters: { operationId: string; [key: string]: Json };
  }>();
  const [error, setError] = createSignal("");
  let sending: { id: string; work: Promise<void> } | undefined;
  function find(id: string): InstallationSnapshot | undefined {
    const current = state();
    return current.activeOperation?.id === id
      ? current.activeOperation
      : current.outcomes.find((item) => item.id === id);
  }
  function acknowledge() {
    const pending = unconfirmed();
    if (pending && find(pending.parameters.operationId)) {
      setUnconfirmed(undefined);
      setError("");
    }
  }
  function receive(next: InstallationState) {
    const newest = (item: InstallationSnapshot) => {
      const known = find(item.id);
      return known && known.revision > item.revision ? known : item;
    };
    const active = next.activeOperation && newest(next.activeOperation);
    setState({
      ...next,
      activeOperation: active && installationActive(active) ? active : null,
      outcomes: [
        ...next.outcomes.map(newest),
        ...(active && !installationActive(active) &&
            !next.outcomes.some((item) => item.id === active.id) ? [active] : []),
      ].slice(-16),
    });
    acknowledge();
  }
  function update(snapshot: InstallationSnapshot) {
    const known = find(snapshot.id);
    if (known && known.revision >= snapshot.revision) return;
    setState((current) => installationActive(snapshot)
      ? { ...current, activeOperation: snapshot }
      : {
        ...current,
        activeOperation: current.activeOperation?.id === snapshot.id
          ? null : current.activeOperation,
        outcomes: [
          ...current.outcomes.filter((item) => item.id !== snapshot.id),
          snapshot,
        ].slice(-16),
      });
    acknowledge();
  }
  function resume(): Promise<void> {
    const pending = unconfirmed();
    if (!pending) return Promise.resolve();
    if (sending?.id === pending.parameters.operationId) return sending.work;
    setError("");
    const work = (async () => {
      try {
        const value = await request(pending.method, pending.parameters);
        update(value as InstallationSnapshot);
      } catch (failure) {
        // A transport/response failure says nothing about the registry commit.
        // Retain the exact input and UUID until an authoritative reply arrives.
        if (!find(pending.parameters.operationId) &&
            unconfirmed()?.parameters.operationId === pending.parameters.operationId) {
          setError(String(failure));
          if (failure instanceof InstallationNotAcceptedError) {
            setUnconfirmed(undefined);
          }
        }
      }
    })();
    const owner = { id: pending.parameters.operationId, work };
    sending = owner;
    void work.finally(() => { if (sending === owner) sending = undefined; });
    return work;
  }
  function start(method: string, parameters: Record<string, Json>) {
    if (unconfirmed() || state().activeOperation) {
      throw new Error("An installation request is already pending");
    }
    setUnconfirmed({
      method,
      parameters: { ...parameters, operationId: crypto.randomUUID() },
    });
    return resume();
  }
  async function observe(id: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      const current = find(id);
      if (current && !installationActive(current)) return;
      const next = await request("modules.installationStatus", {
        operationId: id,
        ...(current ? { afterRevision: current.revision } : {}),
      }, signal) as InstallationSnapshot;
      signal.throwIfAborted();
      update(next);
      if (!installationActive(next)) return;
    }
  }
  async function cancel(id: string) {
    update(await request("modules.cancelInstallation", {
      operationId: id,
    }) as InstallationSnapshot);
  }
  return { state, receive, update, unconfirmed, error, start, resume, observe, cancel };
}
