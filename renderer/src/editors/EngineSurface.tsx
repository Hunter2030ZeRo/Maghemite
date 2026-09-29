import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import type { Workspace } from "../workspace/store";
import type { ViewTab, WorkspaceDocument } from "../workspace/model";
import { type EditorAdapter, type EditorLanguageQuery, EditorText } from "./protocol";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import { readLanguageDocument, sameLanguageVersion } from "../../../modules-sdk/js/project.ts";

export function EngineSurface(
  props: {
    document: WorkspaceDocument;
    workspace: Workspace;
    visible: boolean;
    focused: boolean;
    tab: ViewTab;
    setCursor(value: string): void;
  },
) {
  const diagnosticDocumentId = props.document.id;
  const viewId = props.tab.id;
  const workspace = props.workspace;
  const ownsLanguage = () => {
    const views = workspace.state.tabs.filter((tab) =>
      tab.documentId === diagnosticDocumentId &&
      workspace.state.groups.some((group) => group.activeTab === tab.id));
    return (views.find((tab) => tab.id === workspace.state.activeTab) ?? views[0])?.id === viewId;
  };
  let element!: HTMLDivElement,
    adapter: EditorAdapter | undefined,
    disposed = false;
  const [ready, setReady] = createSignal(false),
    [error, setError] = createSignal("");
  let observer: MutationObserver | undefined;
  type Provider = {
    moduleId: string;
    owner: string;
    language: { id: string; scope: string; features: string[] };
  };
  let provider: Provider | null = null,
    busy = false,
    lastVersion = "",
    lastError = "";
  const requests = new Set<AbortController>();
  const version = () =>
    props.workspace.application.documentVersion(props.document.id);
  const clearDiagnostics = () => {
    if (provider) {
      props.workspace.application.invoke(
        "diagnostics.clear",
        { id: diagnosticDocumentId },
        provider.moduleId,
        provider.owner,
      );
    }
  };
  const requestLanguage = async (
    method: string,
    offset?: number,
    start?: number,
    query?: EditorLanguageQuery,
  ): Promise<unknown> => {
    if (disposed || !props.visible || !props.workspace.diskConnected()) {
      return null;
    }
    const revision = version();
    const documentId = props.document.id;
    const controller = new AbortController();
    requests.add(controller);
    const signal = query?.signal
      ? AbortSignal.any([query.signal, controller.signal])
      : controller.signal;
    if (signal.aborted) {
      requests.delete(controller);
      return null;
    }
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void props.workspace.request("languages.cancel", { requestId }).catch(() => {
        // Disconnect aborts all host calls; there is then nothing left to cancel.
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const reply = await props.workspace.request("languages.request", {
        id: documentId,
        version: revision,
        method,
        requestId,
        ...(offset === undefined ? {} : { offset }),
        ...(start === undefined ? {} : { start }),
        ...(query?.newName === undefined ? {} : { newName: query.newName }),
        ...(query?.includeDeclaration === undefined ? {} : { includeDeclaration: query.includeDeclaration }),
      }) as { provider: Provider; result: unknown } | null;
      if (disposed || signal.aborted || documentId !== props.document.id ||
        revision !== version()) return null;
      if (method === "diagnostics" && !ownsLanguage()) return null;
      if (!reply) return null;
      if (method === "diagnostics") {
        if (provider?.owner !== reply.provider.owner) clearDiagnostics();
        provider = reply.provider;
        const text = new EditorText(props.document.content);
        const items = ((reply.result ?? []) as {
          message: string;
          severity: string;
          range: { from: number; to: number };
        }[]).map((d) => {
          const a = text.position(d.range.from),
            b = text.position(d.range.to);
          return {
            message: d.message,
            severity: d.severity,
            line: a.line,
            column: a.column,
            endLine: b.line,
            endColumn: b.column,
          };
        });
        props.workspace.application.invoke(
          "diagnostics.publish",
          {
            id: props.document.id,
            documentId: props.document.id,
            version: revision,
            items,
          } as Json,
          provider.moduleId,
          provider.owner,
        );
      }
      if (lastError) props.workspace.notify("Language service restored");
      lastError = "";
      return reply.result;
    } catch (error) {
      if (!disposed && !signal.aborted && documentId === props.document.id &&
        revision === version() && lastError !== String(error)) {
        lastError = String(error);
        props.workspace.notify(`Language service: ${lastError}`);
      }
      return null;
    } finally {
      requests.delete(controller);
      signal.removeEventListener("abort", cancel);
    }
  };
  const refreshLanguage = async () => {
    if (
      busy || disposed || !ready() || !props.visible || !ownsLanguage() ||
      props.document.kind !== "code" || !props.workspace.diskConnected()
    ) return;
    busy = true;
    try {
      const status = await props.workspace.request("languages.request", {
        id: props.document.id,
        method: "status",
      }) as Provider | null;
      if (disposed || !ownsLanguage()) return;
      if (provider?.owner !== status?.owner) {
        clearDiagnostics();
        lastVersion = "";
      }
      provider = status;
      adapter?.language?.(
        provider?.language.id ?? null,
        provider?.language.features,
        provider?.owner,
      );
      const current = version();
      if (
        provider?.language.features.includes("diagnostics") &&
        lastVersion !== current
      ) {
        await requestLanguage("diagnostics");
        if (!disposed && version() === current && !lastError) {
          lastVersion = current;
        }
      }
    } catch (error) {
      if (disposed || !ownsLanguage()) return;
      clearDiagnostics();
      provider = null;
      adapter?.language?.(null);
      lastVersion = "";
      if (!disposed && lastError !== String(error)) {
        lastError = String(error);
        props.workspace.notify(`Language service: ${lastError}`);
      }
    } finally {
      busy = false;
    }
  };
  const configure = () =>
    adapter?.configure(
      props.workspace.preferences.effective(),
      props.document.language,
    );
  onMount(() => {
    void (async () => {
      try {
        const engine = props.document.kind === "note"
          ? await import("./codemirror")
          : await import("./monaco");
        if (disposed) return;
        adapter = engine.createEditor(element, {
          id: `${
            props.workspace.workspaceInfo()?.id ?? "preview"
          }/${props.document.id}`,
          path: props.document.path,
          workspaceId: props.workspace.workspaceInfo()?.id,
          text: props.document.content,
          language: props.document.language,
          settings: props.workspace.preferences.effective(),
          viewState: props.tab.view?.editor,
          isFocused: () => !disposed && props.focused,
          isVisible: () => !disposed && props.visible,
          viewStateChanged: (editor) => {
            if (!disposed) workspace.viewState(viewId, { editor });
          },
          requestLanguage,
          previewLanguageLocation: async (location, signal) => {
            const api = createAppAPI(async (method, parameters) => {
              signal.throwIfAborted();
              const result = method === "documents.list" || method === "documents.read"
                ? props.workspace.application.invoke(method, parameters, "maghemite.workbench")
                : await props.workspace.request(method, parameters);
              signal.throwIfAborted();
              return result;
            });
            const snapshot = await readLanguageDocument(api.request, location.path);
            if (!sameLanguageVersion(snapshot.version, location.version)) {
              throw new Error("Language preview changed; request the operation again");
            }
            return snapshot.text;
          },
          openLanguageLocation: async (location) => {
            await props.workspace.request("languages.open", {
              proposal: location.proposal, path: location.path,
              from: location.range.from, to: location.range.to,
            });
          },
          applyWorkspaceEdit: async (proposal) => {
            await props.workspace.request("languages.apply", { proposal });
          },
          notify: props.workspace.notify,
          change: (text) => props.workspace.edit(props.document.id, text),
          selection: (anchor, head, position) => {
            if (disposed || !props.focused || !props.visible) return;
            props.workspace.application.selection(
              props.document.id,
              anchor,
              head,
            );
            props.setCursor(`Ln ${position.line}, Col ${position.column + 1}`);
          },
        });
        observer = new MutationObserver(configure);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["style", "data-theme"],
        });
        setReady(true);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    })();
  });
  // Engine transactions may synchronously notify Solid. Apply reactive updates after the engine finishes its transaction.
  let selectionRevision = -1;
  const later = (operation: () => void) =>
    queueMicrotask(() => {
      if (!disposed && adapter) untrack(operation);
    });
  createEffect(() => {
    void props.document.content;
    if (ready()) later(() => adapter!.setText(props.document.content));
  });
  createEffect(() => {
    const settings = props.workspace.preferences.effective(),
      language = props.document.language;
    if (ready()) later(() => adapter!.configure(settings, language));
  });
  createEffect(() => {
    const selection = props.workspace.requestedSelection();
    if (
      ready() && props.visible && props.focused && selection?.id === props.document.id &&
      selection.viewId === viewId &&
      selection.revision !== selectionRevision
    ) {
      selectionRevision = selection.revision;
      later(() => adapter!.select(selection.anchor, selection.head));
    }
  });
  createEffect(() => {
    if (!props.focused || !props.visible || !ready()) return;
    const selection = props.tab.view?.editor?.selections[0];
    const position = new EditorText(props.document.content).position(selection?.head ?? 0);
    props.setCursor(`Ln ${position.line}, Col ${position.column + 1}`);
  });
  createEffect(() => {
    const visible = props.visible;
    if (ready()) {
      later(() => {
        adapter!.visible?.(visible);
        if (visible) adapter!.layout();
      });
    }
  });
  createEffect(() => {
    props.workspace.contributionRevision();
    void props.document.content;
    const items = props.workspace.application.diagnostics().filter((d) =>
      d.documentId === props.document.id
    ).flatMap((d) => d.items);
    if (ready()) later(() => adapter!.diagnostics(items));
  });
  let languageTimer: ReturnType<typeof setTimeout> | undefined;
  // Hidden tabs and note editors need no language-status wakeups.
  createEffect(() => {
    if (
      !props.visible || !ownsLanguage() || props.document.kind !== "code" ||
      !props.workspace.diskConnected()
    ) return;
    const poll = setInterval(() => void refreshLanguage(), 2000);
    onCleanup(() => clearInterval(poll));
  });
  createEffect(() => {
    void props.document.content;
    void props.visible;
    ownsLanguage();
    ready();
    props.workspace.diskConnected();
    clearTimeout(languageTimer);
    languageTimer = setTimeout(() => void refreshLanguage(), 350);
  });
  onCleanup(() => {
    disposed = true;
    clearTimeout(languageTimer);
    for (const request of requests) request.abort();
    if (!workspace.state.tabs.some((tab) => tab.id !== viewId &&
      tab.documentId === diagnosticDocumentId)) clearDiagnostics();
    observer?.disconnect();
    adapter?.dispose();
    adapter = undefined;
  });
  return (
    <>
      <div
        class="engine-surface"
        data-engine={props.document.kind === "note" ? "codemirror" : "monaco"}
        ref={(node) => { element = node; }}
      />
      <Show when={error()}>
        <p role="alert" class="empty-copy">Editor failed to load: {error()}</p>
      </Show>
    </>
  );
}
