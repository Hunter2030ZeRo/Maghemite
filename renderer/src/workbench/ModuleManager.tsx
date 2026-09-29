import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { Workspace } from "../workspace/store";
import { createModuleRefresh } from "../workspace/module_refresh";
import {
  ATTACHMENT_MEMORY_LIMIT,
  attachmentMemoryBytes,
} from "../workspace/attachments";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import type {
  ModulePage,
  ModuleStatus,
  ResourceSnapshot,
} from "../../../src/shared/module_resources.ts";
import "./ModuleManager.css";

type Review =
  & Pick<
    ModuleStatus,
    | "id"
    | "version"
    | "runtime"
    | "capabilities"
    | "grants"
    | "languageFeatures"
  >
  & { token: string; update: boolean };
const memory = (bytes: number | null) =>
  bytes === null ? "Unknown" : `${(bytes / 1048576).toFixed(1)} MiB`;
export function ModuleManager(props: { workspace: Workspace }) {
  const [items, setItems] = createSignal<ModuleStatus[]>([]),
    [directory, setDirectory] = createSignal("");
  const [resources, setResources] = createSignal<ResourceSnapshot>();
  const [diskUsage, setDiskUsage] = createSignal<ModulePage["diskUsage"]>();
  const [refreshing, setRefreshing] = createSignal(false);
  const [pending, setPending] = createSignal("");
  let disposed = false;
  const [review, setReview] = createSignal<Review>(),
    [grants, setGrants] = createSignal<string[]>([]);
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const installation = props.workspace.installations;
  const activeId = createMemo(() => installation.state().activeOperation?.id);
  const operation = () => installation.state().activeOperation ??
    installation.state().outcomes.at(-1);
  const mutationBusy = () => busy() || !!activeId() ||
    !!installation.unconfirmed() || !props.workspace.diskConnected();
  const [cancelling, setCancelling] = createSignal(false);
  const lifetime = new AbortController();
  const call = (method: string, parameters: Json = {}) =>
    props.workspace.request(method, parameters, lifetime.signal);
  const refresh = createModuleRefresh(async () => {
    setRefreshing(true);
    try {
      await call("modules.rendererResources", {
        attachmentBytes: attachmentMemoryBytes(),
        attachmentLimitBytes: ATTACHMENT_MEMORY_LIMIT,
      });
      const all: ModuleStatus[] = [];
      let offset = 0;
      for (;;) {
        const page = await call("modules.list", { offset }) as ModulePage;
        if (disposed) return;
        all.push(...page.items);
        setResources(page.resources);
        setDiskUsage(page.diskUsage);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      setItems(all);
    } finally {
      if (!disposed) setRefreshing(false);
    }
  });
  async function perform(
    action: () => Promise<void>,
    label = "Updating modules",
  ) {
    if (busy()) return;
    setBusy(true);
    setError("");
    setPending(label);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      try {
        await refresh();
      } catch (e) {
        if (!disposed) {
          setError((old) => [old, String(e)].filter(Boolean).join("; "));
        }
      }
      if (!disposed) {
        setBusy(false);
        setPending("");
      }
    }
  }
  createEffect(() => {
    if (props.workspace.diskConnected()) {
      void untrack(refresh).catch((e) => { if (!disposed) setError(String(e)); });
    }
  });
  createEffect(() => {
    const id = activeId();
    if (!id || !props.workspace.diskConnected()) return;
    const subscription = new AbortController();
    void untrack(() => installation.observe(id, subscription.signal)).catch((e) => {
      if (!subscription.signal.aborted && !disposed) setError(String(e));
    });
    onCleanup(() => subscription.abort());
  });
  const exposed = () => void refresh().catch((e) => {
    if (!disposed) setError(String(e));
  });
  window.addEventListener("maghemite:modules-changed", exposed);
  onCleanup(() => {
    disposed = true;
    lifetime.abort();
    window.removeEventListener("maghemite:modules-changed", exposed);
    const token = review()?.token;
    if (token && !installation.unconfirmed()) {
      void props.workspace.request("modules.cancel", { token }).catch(() => {});
    }
  });
  function configure(
    item: ModuleStatus,
    next: string[],
    enabled = item.enabled,
  ) {
    void perform(async () => {
      await call("modules.configure", { id: item.id, grants: next, enabled });
    });
  }
  return (
    <div class="module-manager">
      <section
        class="module-resource-summary"
        aria-label="Application resource admission"
      >
        <div class="module-list-heading">
          <strong>Application admission</strong>
          <button
            disabled={refreshing()}
            onClick={() => void refresh().catch((e) => setError(String(e)))}
          >
            {refreshing() ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <Show when={resources()}>
          {(snapshot) => (
            <>
              <dl class="module-resource-values">
                <dt>Charged / budget</dt>
                <dd>
                  {memory(snapshot().chargedBytes)} /{" "}
                  {memory(snapshot().budgetBytes)}
                </dd>
                <dt>Core RSS</dt>
                <dd>{memory(snapshot().coreRssBytes)}</dd>
                <dt>Owned tree RSS</dt>
                <dd>{memory(snapshot().ownedTree.rssBytes)}</dd>
                <dt>Module RSS</dt>
                <dd>{memory(snapshot().observedModuleRssBytes)}</dd>
                <dt>Reserved</dt>
                <dd>{memory(snapshot().reservedBytes)}</dd>
                <dt>Installed AOT</dt>
                <dd>{memory(diskUsage()?.installedAotBytes ?? null)}</dd>
                <dt>Legacy cache</dt>
                <dd>{memory(diskUsage()?.legacyCacheBytes ?? null)}</dd>
                <dt>Preparing</dt>
                <dd>
                  {snapshot().compilation.active} /{" "}
                  {snapshot().compilation.limit}
                </dd>
                <dt>Waiting</dt>
                <dd>{snapshot().queued} / {snapshot().queueLimit}</dd>
              </dl>
              <p class="small muted">
                Admission estimates, not a hard RSS cap.
              </p>
              <details class="module-measurement-details">
                <summary>Measurement details</summary>
              <p class="small muted">
                Tree source: {snapshot().ownedTree.source}.{" "}
                {snapshot().ownedTree.complete
                  ? "Complete snapshot"
                  : "Partial or unavailable"}. External dev browsers are
                excluded.
              </p>
              <Show
                when={snapshot().external.length}
                fallback={
                  <p class="small muted">
                    No additional host reservations have been reported.
                  </p>
                }
              >
                <For each={snapshot().external}>
                  {(owner) => (
                    <p class="small muted">
                      {owner.label}
                      <Show when={owner.pid}> (PID {owner.pid})</Show>
                      : RSS {memory(owner.rssBytes)}, reserved{" "}
                      {memory(owner.reservedBytes)}, disk{" "}
                      {memory(owner.diskBytes)}
                      <Show
                        when={owner.retainedBytes !== undefined &&
                          owner.limitBytes !== undefined}
                      >
                        {" "}· retained Blob bytes{" "}
                        {memory(owner.retainedBytes ?? null)} /{" "}
                        {memory(owner.limitBytes ?? null)}{" "}
                        (renderer-reported, not RSS)
                      </Show>
                    </p>
                  )}
                </For>
              </Show>
              <p class="small muted">
                Snapshot{" "}
                {new Date(snapshot().sampledAt).toLocaleTimeString()}. Refresh
                to recheck pressure.
              </p>
              </details>
            </>
          )}
        </Show>
      </section>
      <Show when={pending()}>
        <p class="small" role="status">{pending()}...</p>
      </Show>
      <Show when={operation()}>
        {(item) => (
          <section class="module-card module-installation"
            data-installation-phase={item().phase}
            data-installation-id={item().id}
            aria-label="Module installation">
            <strong>{item().moduleId}</strong>
            <p class="small" role="status">
              {item().kind === "maintenance" ? "Maintenance" : "Installation"}:{" "}
              {item().phase} · {item().completedTargets} / {item().totalTargets} targets
              {item().committed ? " · committed" : ""}
            </p>
            <Show when={item().error}>
              <p class="module-failure" role="alert">{item().error}</p>
            </Show>
            <Show when={activeId() === item().id}>
              <button type="button" aria-label="Cancel installation"
                disabled={cancelling() || !props.workspace.diskConnected()}
                onClick={async () => {
                  setCancelling(true);
                  try { await installation.cancel(item().id); }
                  catch (e) { if (!disposed) setError(String(e)); }
                  finally { if (!disposed) setCancelling(false); }
                }}>
                {cancelling() ? "Requesting cancellation" : "Cancel installation"}
              </button>
            </Show>
            <Show when={!props.workspace.diskConnected()}>
              <p class="small muted" role="status">
                Disconnected. Installation continues in the desktop; reconnecting.
              </p>
            </Show>
          </section>
        )}
      </Show>
      <Show when={installation.unconfirmed()}>
        {(request) => (
          <section class="module-card module-installation"
            data-installation-id={request().parameters.operationId}>
            <p class="small" role="status">
              Confirming installation acceptance. Reconnect keeps this request's identity.
            </p>
            <Show when={installation.error()}>
              <button type="button" disabled={!props.workspace.diskConnected()}
                onClick={() => void installation.resume()}>Retry installation request</button>
            </Show>
          </section>
        )}
      </Show>
      <For each={installation.state().maintenance}>
        {(item) => (
          <section class="module-card">
            <strong>{item.id}</strong>
            <p class="module-failure" role="alert">{item.error}</p>
            <button type="button" disabled={mutationBusy()} onClick={() =>
              void installation.start("modules.maintain", { id: item.id })}>
              Retry maintenance
            </button>
          </section>
        )}
      </For>
      <p class="small muted">
        Install a local package built with the Modules SDK. Updates use the same
        module ID.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            if (review()) {
              await call("modules.cancel", { token: review()!.token });
            }
            setReview(undefined);
            const next = await call("modules.prepare", {
              directory: directory().trim(),
            }) as unknown as Review;
            setReview(next);
            setGrants(next.grants);
          });
        }}
      >
        <label>
          Package directory<input
            aria-label="Module package directory"
            placeholder="/path/to/package"
            value={directory()}
            onInput={(event) => setDirectory(event.currentTarget.value)}
          />
        </label>
        <button disabled={mutationBusy() || !directory().trim()}>Review package</button>
      </form>
      <Show when={error() || installation.error()}>
        <p role="alert" class="module-error">{error() || installation.error()}</p>
      </Show>
      <Show when={review()}>
        {(item) => (
          <section
            class="module-card module-review"
            aria-label="Review module permissions"
          >
            <strong>{item().id}</strong>
            <span class="small muted">
              {item().version} · {item().runtime.toUpperCase()}
            </span>
            <p class="small">
              Choose permissions before{" "}
              {item().update ? "updating" : "installing"}. Denied features may
              be unavailable.
            </p>
            <Show
              when={item().languageFeatures?.length &&
                (!grants().includes("documents.read") ||
                  (item().capabilities.includes("wasm.execute") &&
                    !grants().includes("wasm.execute")))}
            >
              <p class="small">
                Allow documents.read and, when requested, wasm.execute to enable
                this module's language features.
              </p>
            </Show>
            <For
              each={item().capabilities}
              fallback={<p class="small">No permissions requested.</p>}
            >
              {(capability) => (
                <label class="module-permission">
                  <input
                    type="checkbox"
                    checked={grants().includes(capability)}
                    onChange={(event) =>
                      setGrants((old) =>
                        event.currentTarget.checked
                          ? [...old, capability]
                          : old.filter((c) => c !== capability)
                      )}
                  />
                  {capability}
                </label>
              )}
            </For>
            <div class="module-actions">
              <button
                disabled={mutationBusy()}
                onClick={() =>
                  void perform(async () => {
                    const accepting = installation.start("modules.install", {
                      token: item().token,
                      grants: grants(),
                    });
                    setReview(undefined);
                    await accepting;
                  })}
              >
                {item().update ? "Update module" : "Install module"}
              </button>
              <button
                disabled={mutationBusy()}
                onClick={() =>
                  void perform(async () => {
                    await call("modules.cancel", { token: item().token });
                    setReview(undefined);
                  })}
              >
                Cancel
              </button>
            </div>
          </section>
        )}
      </Show>
      <div class="module-list-heading">
        <strong>Installed</strong>
      </div>
      <For
        each={items()}
        fallback={<p class="empty-copy">No modules installed.</p>}
      >
        {(item) => (
          <section class="module-card" aria-label={`Module ${item.id}`}>
            <strong>{item.id}</strong>
            <span class="small muted">
              {item.version} · {item.runtime.toUpperCase()} · {item.state}
              {item.busy ? " · busy" : ""}
            </span>
            <span class="small muted">
              {item.commands} commands · {item.themes} themes
            </span>
            <Show when={item.error}>
              <p class="module-failure" role="alert">{item.error}</p>
            </Show>
            <dl class="module-resource-values">
              <dt>Owned processes</dt>
              <dd>{item.resources.processes.length}</dd>
              <dt>RSS / reserved</dt>
              <dd>
                {memory(item.resources.rssBytes)} /{" "}
                {memory(item.resources.reservedBytes)}
              </dd>
              <dt>Admission queue</dt>
              <dd>{item.resources.queued}</dd>
              <dt>Installed AOT</dt>
              <dd>{memory(item.resources.installedAotBytes)}</dd>
            </dl>
            <For each={item.resources.processes}>
              {(process) => (
                <span class="small muted">
                  {process.kind}
                  {process.worker ? " worker" : ""}:{" "}
                  {process.phase} · RSS
                  {" "}
                  {memory(process.rssBytes)}
                </span>
              )}
            </For>
            <Show when={item.resources.limits.linearMemoryBytes !== null}>
              <p class="small muted">
                Linear memory: {memory(item.resources.limits.linearMemoryBytes)}
                {" "}
                per memory, up to {item.resources.limits.memories}{" "}
                memories. Not total RSS.
              </p>
            </Show>
            <Show when={item.resources.limits.oldSpaceBytes !== null}>
              <p class="small muted">
                V8 old-space limit:{" "}
                {memory(item.resources.limits.oldSpaceBytes)}. Not total RSS.
              </p>
            </Show>
            <Show when={item.resources.limits.wasiToolMemoryBytes !== null}>
              <p class="small muted">
                WASI tool linear-memory limit:{" "}
                {memory(item.resources.limits.wasiToolMemoryBytes)} per tool.
              </p>
            </Show>
            <Show when={item.runtime !== "theme"}>
              <div class="module-actions">
                <button
                  disabled={mutationBusy() || !item.enabled ||
                    item.state === "restarting"}
                  onClick={() =>
                    void perform(async () => {
                      await call("modules.restart", { id: item.id });
                    }, `Restarting ${item.id}`)}
                >
                  Restart
                </button>
                <span class="small muted">
                  Cancels module work; keeps drafts.
                </span>
              </div>
            </Show>
            <Show
              when={item.languageFeatures?.length && item.managed &&
                (!item.grants.includes("documents.read") ||
                  (item.capabilities.includes("wasm.execute") &&
                    !item.grants.includes("wasm.execute")))}
            >
              <p class="small module-error" role="status">
                Language features are paused. Allow documents.read and, when
                requested, wasm.execute in Permissions.
              </p>
            </Show>
            <Show
              when={item.managed}
              fallback={<p class="small muted">Managed by launch options.</p>}
            >
              <details
                open={expanded()[item.id]}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setExpanded((old) => ({ ...old, [item.id]: open }));
                }}
              >
                <summary>Permissions</summary>
                <For each={item.capabilities}>
                  {(capability) => (
                    <label class="module-permission">
                      <input
                        type="checkbox"
                        disabled={mutationBusy()}
                        checked={item.grants.includes(capability)}
                        onChange={(event) =>
                          configure(
                            item,
                            event.currentTarget.checked
                              ? [...item.grants, capability]
                              : item.grants.filter((c) => c !== capability),
                          )}
                      />
                      {capability}
                    </label>
                  )}
                </For>
              </details>
              <div class="module-actions">
                <button
                  disabled={mutationBusy()}
                  onClick={() =>
                    configure(item, item.grants, !item.enabled)}
                >
                  {item.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  disabled={mutationBusy()}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${item.id}? Its saved module data will be retained.`,
                      )
                    ) {
                      void perform(async () => {
                        await call("modules.remove", { id: item.id });
                      });
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
}
