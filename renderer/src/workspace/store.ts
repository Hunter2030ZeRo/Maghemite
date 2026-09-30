import { batch, createMemo, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  type Activity,
  decodeSession,
  defaultLayout,
  documentFromText,
  filename,
  type GroupSession,
  type Session,
  type ViewTab,
  type WorkspaceMode,
} from "./model";
import { sampleDocuments } from "./sample";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { createKnowledge } from "./knowledge";
import { createRecovery } from "./recovery";
import { createPreferences } from "./preferences";
import { createInstallations, type InstallationRequest } from "./installations";
import { createWorkbenchApplication } from "./application";
import { createWorkspaceFiles } from "./files";
import { observeWorkspaceFiles } from "./file_events";
import { FileMoveError } from "../../../src/shared/file_moves.ts";
import {
  activateView, addView, closeGroup as removeGroup, closeView,
  focusGroup as selectGroup, groupedSession, moveView, recoverableSession,
  resizeGroups, splitGroup as copyGroup,
} from "./groups";

const KEY = "maghemite.workspace-preview.v1";

/** Browser preview adapter. Desktop filesystem access stays behind the host boundary. */
export function createWorkspace() {
  let restored: Session | undefined;
  try {
    restored = decodeSession(localStorage.getItem(KEY));
  } catch { /* Storage may be disabled. */ }
  const [state, set] = createStore<GroupSession>(
    groupedSession(restored ?? {
      version: 1,
      documents: sampleDocuments(),
      tabs: [{
        id: "doc:notes/Workspace.md",
        type: "document",
        documentId: "notes/Workspace.md",
      }, {
        id: "doc:src/main.ts",
        type: "document",
        documentId: "src/main.ts",
      }],
      activeTab: "doc:notes/Workspace.md",
      mode: "develop",
      layout: { ...defaultLayout },
    }),
  );
  const [viewEpoch, setViewEpoch] = createSignal(1);
  const [activity, setActivity] = createSignal<Activity>(
    state.mode === "knowledge" ? "notes" : "files",
  );
  const [workspaceInfo, setWorkspaceInfo] = createSignal<
    { id: string; label: string; path: string } | null
  >(null);
  let sessionKey = KEY;
  const diskDocuments = createMemo(() =>
    state.documents.filter((d) => d.diskVersion).map((d) => d.id)
  );
  const [diskConnected, setDiskConnected] = createSignal(false);
  let hostRequest:
    | InstallationRequest
    | undefined;
  const saving = new Set<string>();
  let saveQueue: Promise<void> = Promise.resolve();
  let workspaceGeneration = 0;
  const [diskErrors, setDiskErrors] = createSignal<Record<string, string>>({});
  const preferences = createPreferences(notify);
  const recovery = createRecovery(notify);
  const installations = createInstallations(request);
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const [contributionRevision, refreshContributions] = createSignal(0);
  const [requestedSelection, setRequestedSelection] = createSignal<
    { id: string; viewId: string; anchor: number; head: number; revision: number }
  >();
  let selectionRevision = 0;
  const [message, setMessage] = createSignal("Sample workspace ready");
  const [storageError, setStorageError] = createSignal(false);
  const [events, setEvents] = createSignal<string[]>([
    "Opened sample workspace. Files on disk are unchanged.",
  ]);
  const activeTab = createMemo(() =>
    state.tabs.find((t) => t.id === state.activeTab)
  );
  const activeDocument = createMemo(() =>
    state.documents.find((d) => d.id === activeTab()?.documentId)
  );
  const knowledge = createKnowledge(() => state.documents, request);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    clearTimeout(saveTimer);
    try {
      const serialized = JSON.stringify(recoverableSession(state));
      if (serialized.length > 3_000_000) {
        throw new Error("Preview storage limit");
      }
      if (workspaceInfo()) recovery.save(serialized);
      localStorage.setItem(sessionKey, serialized);
      setStorageError(false);
      return true;
    } catch {
      setStorageError(true);
      return false;
    }
  }
  async function prepareWorkspaceChange() {
    for (const timer of autoSaveTimers.values()) clearTimeout(timer);
    autoSaveTimers.clear();
    await saveQueue;
    for (const timer of autoSaveTimers.values()) clearTimeout(timer);
    autoSaveTimers.clear();
    if (!persist()) {
      throw new Error(
        "Could not preserve drafts. Free browser storage or download edited files before opening another folder.",
      );
    }
    if (workspaceInfo()) await recovery.checkpoint();
  }
  function schedule() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  }
  function notify(text: string) {
    setMessage(text);
    setEvents((e) => [...e.slice(-49), text]);
  }
  function updateGroups(next: GroupSession) {
    const changedFocus = state.activeTab !== next.activeTab || state.activeGroup !== next.activeGroup;
    batch(() => {
      set("tabs", reconcile(next.tabs));
      set("groups", reconcile(next.groups));
      set("activeGroup", next.activeGroup);
      set("activeTab", next.activeTab);
    });
    const doc = activeDocument(), selection = activeTab()?.view?.editor?.selections[0];
    if (doc && changedFocus) application.selection(doc.id,
      Math.min(selection?.anchor ?? 0, doc.content.length),
      Math.min(selection?.head ?? 0, doc.content.length));
    schedule();
  }
  function viewState(id: string, value: NonNullable<ViewTab["view"]>) {
    const tab = state.tabs.find((tab) => tab.id === id);
    if (!tab) return;
    set("tabs", (tab) => tab.id === id, "view", { ...tab.view, ...value });
    schedule();
  }
  function focusGroup(id: string) {
    if (id !== state.activeGroup) updateGroups(selectGroup(state, id));
  }
  function splitGroup(id = state.activeGroup) {
    updateGroups(copyGroup(state, id, `group:${crypto.randomUUID()}`, `editor:${crypto.randomUUID()}`));
  }
  function closeGroup(id = state.activeGroup) {
    updateGroups(removeGroup(state, id));
  }
  function moveTab(id: string, destination: string) {
    updateGroups(moveView(state, id, destination));
  }
  function resizeGroup(id: string, size: number) {
    updateGroups(resizeGroups(state, id, size));
  }
  function open(id: string) {
    const doc = state.documents.find((d) => d.id === id);
    if (!doc) return;
    const group = state.groups.find((group) => group.id === state.activeGroup);
    const existing = state.tabs.find((tab) => tab.documentId === id && group?.tabs.includes(tab.id));
    if (existing) activate(existing.id);
    else updateGroups(addView(state, {
      id: `editor:${crypto.randomUUID()}`, type: "document", documentId: id,
    }));
  }
  function openGraph() {
    if (state.tabs.some((tab) => tab.id === "graph")) activate("graph");
    else updateGroups(addView(state, { id: "graph", type: "graph" }));
  }
  function activate(id: string) {
    updateGroups(activateView(state, id));
  }
  function close(id: string) {
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const doc = state.documents.find((d) =>
      d.id === state.tabs[index].documentId
    );
    updateGroups(closeView(state, id));
    if (doc && doc.content !== doc.savedContent) {
      notify(
        `Closed ${
          filename(doc.path)
        }. Your draft is retained in the workspace.`,
      );
    }
  }
  function edit(id: string, content: string) {
    if (state.documents.find((document) => document.id === id)?.content === content) return;
    application.changed(id);
    set("documents", (d) => d.id === id, "content", content);
    schedule();
    clearTimeout(autoSaveTimers.get(id));
    if (preferences.effective().autoSave && diskDocuments().includes(id)) {
      autoSaveTimers.set(
        id,
        setTimeout(() => {
          autoSaveTimers.delete(id);
          if (preferences.effective().autoSave && diskConnected()) {
            void save(id);
          }
        }, preferences.effective().autoSaveDelay),
      );
    }
  }
  async function request(method: string, parameters: Json = {}, signal?: AbortSignal) {
    if (!hostRequest || !diskConnected()) {
      throw new Error(
        "Desktop disconnected. Your draft is retained; reconnect to save to disk.",
      );
    }
    return await hostRequest(method, {
      ...(parameters as Record<string, Json>),
      workspaceId: workspaceInfo()?.id ?? null,
    }, signal);
  }
  async function save(documentId = activeDocument()?.id) {
    const doc = state.documents.find((d) => d.id === documentId);
    if (!doc || saving.has(doc.id)) return;
    if (doc.diskVersion || workspaceInfo()) {
      const generation = workspaceGeneration;
      saving.add(doc.id);
      const preceding = saveQueue;
      let release!: () => void;
      saveQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await preceding;
      try {
        if (generation !== workspaceGeneration) return;
        if (doc.diskVersion) {
          await request("documents.resume", {
            path: doc.path,
            diskVersion: doc.diskVersion,
          });
        }
        if (generation !== workspaceGeneration) return;
        const data = application.invoke(
          "documents.read",
          { id: doc.id },
          "maghemite.workbench",
        ) as { document: { version: string } };
        await request(
          doc.diskVersion ? "documents.save" : "documents.saveNew",
          { id: doc.id, version: data.document.version },
        );
        setDiskErrors((errors) => {
          const next = { ...errors };
          delete next[doc.id];
          return next;
        });
        notify(`Saved ${filename(doc.path)} to disk`);
      } catch (e) {
        const error = String(e);
        setDiskErrors((errors) => ({ ...errors, [doc.id]: error }));
        notify(error);
      } finally {
        release();
        saving.delete(doc.id);
        if (
          generation === workspaceGeneration &&
          preferences.effective().autoSave && diskConnected() &&
          !diskErrors()[doc.id] && doc.content !== doc.savedContent
        ) {
          clearTimeout(autoSaveTimers.get(doc.id));
          autoSaveTimers.set(
            doc.id,
            setTimeout(() => {
              autoSaveTimers.delete(doc.id);
              if (
                preferences.effective().autoSave && diskConnected()
              ) void save(doc.id);
            }, preferences.effective().autoSaveDelay),
          );
        }
      }
      return;
    }
    const previous = doc.savedContent;
    set("documents", (d) => d.id === doc.id, "savedContent", doc.content);
    if (persist()) notify(`Saved ${filename(doc.path)} in this browser`);
    else {
      set("documents", (d) => d.id === doc.id, "savedContent", previous);
      notify(
        "Browser storage is full or unavailable. Download your file to keep it.",
      );
    }
  }
  async function openFile(path: string) {
    const existing = state.documents.find((d) => d.path === path);
    if (existing) {
      open(existing.id);
      return;
    }
    try {
      await request("documents.openFile", { path });
    } catch (e) {
      notify(String(e));
    }
  }
  async function reloadFile(id: string) {
    const doc = state.documents.find((d) => d.id === id);
    if (!doc?.diskVersion) return;
    if (
      doc.content !== doc.savedContent &&
      !window.confirm(
        "Reload this file from disk and discard the current edits? Download a copy first if you want to keep them.",
      )
    ) return;
    try {
      const data = application.invoke(
        "documents.read",
        { id },
        "maghemite.workbench",
      ) as { document: { version: string } };
      await request("documents.reload", {
        path: doc.path,
        version: data.document.version,
      });
      setDiskErrors((errors) => {
        const next = { ...errors };
        delete next[id];
        return next;
      });
      notify(`Reloaded ${filename(doc.path)} from disk`);
    } catch (e) {
      notify(String(e));
    }
  }
  async function checkDiskFiles() {
    const generation = workspaceGeneration;
    for (const doc of state.documents.filter((d) => d.diskVersion)) {
      if (!diskConnected() || generation !== workspaceGeneration) break;
      if (saving.has(doc.id)) continue;
      const diskVersion = doc.diskVersion!;
      try {
        await request("documents.resume", { path: doc.path, diskVersion });
        if (
          generation === workspaceGeneration && diskVersion === doc.diskVersion
        ) {
          setDiskErrors((errors) => {
            const next = { ...errors };
            delete next[doc.id];
            return next;
          });
        }
      } catch (e) {
        if (
          generation === workspaceGeneration && diskVersion === doc.diskVersion
        ) {
          setDiskErrors((errors) => ({ ...errors, [doc.id]: String(e) }));
        }
      }
    }
  }
  async function connectHost(
    info: { id: string; label: string; path: string } | null,
    remote: typeof hostRequest,
  ) {
    const key = info ? `maghemite.workspace.v1.${info.id}` : KEY;
    if (key !== sessionKey) {
      if (!persist()) {
        throw new Error(
          "Cannot switch workspace while recovery storage is unavailable",
        );
      }
      workspaceGeneration++;
      knowledge.reset();
      for (const timer of autoSaveTimers.values()) clearTimeout(timer);
      autoSaveTimers.clear();
      let restored: Session | undefined;
      try {
        restored = decodeSession(localStorage.getItem(key));
      } catch { /* Use an empty session. */ }
      application.reset();
      application.resetDocuments();
      batch(() => {
        setWorkspaceInfo(info);
        set(
          reconcile(groupedSession(restored ??
            {
              version: 1,
              documents: [],
              tabs: [],
              activeTab: null,
              mode: "develop",
              layout: { ...defaultLayout },
            })),
        );
        setRequestedSelection(undefined);
        setViewEpoch((epoch) => epoch + 1);
      });
      sessionKey = key;
      setDiskErrors({});
    }
    setWorkspaceInfo(info);
    hostRequest = remote;
    setDiskConnected(!!remote);
    if (remote) void installations.resume();
    if (info && remote) {
      try {
        const host = decodeSession(
          await recovery.connect(key, request) ?? null,
        );
        if (host) {
          application.reset();
          application.resetDocuments();
          batch(() => {
            set(reconcile(groupedSession(host)));
            setRequestedSelection(undefined);
            setViewEpoch((epoch) => epoch + 1);
          });
        }
        persist();
      } catch (error) {
        notify(`Could not restore host recovery. ${String(error)}`);
      }
    }
    if (info) knowledge.connect();
    notify(info ? `Opened ${info.label}` : "Desktop connected");
  }
  function disconnectHost() {
    files.reset();
    recovery.disconnect();
    knowledge.disconnect();
    hostRequest = undefined;
    setDiskConnected(false);
    preferences.disconnect();
    // Disk identity and unsaved status survive a transport failure.
    persist();
  }
  function openSettings() {
    if (state.tabs.some((tab) => tab.id === "settings")) activate("settings");
    else updateGroups(addView(state, { id: "settings", type: "settings" }));
  }
  async function createFile(path: string) {
    if (
      !path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    ) throw new Error("Use a workspace-relative file path");
    if (state.mode === "knowledge" && !/\.mdx?$/i.test(path)) {
      throw new Error("Knowledge files must use .md or .mdx");
    }
    if (state.mode === "develop" && /\.mdx?$/i.test(path)) {
      throw new Error("Switch to Knowledge to create a Markdown note");
    }
    application.invoke(
      "documents.create",
      { path, text: "" },
      "maghemite.workbench",
    );
    open(path);
    await save(path);
  }
  function mode(value: WorkspaceMode) {
    set("mode", value);
    setActivity(value === "develop" ? "files" : "notes");
    schedule();
  }
  function layout(value: Partial<Session["layout"]>) {
    set("layout", value);
    schedule();
  }
  function newNote() {
    let n = 1;
    const prefix = workspaceInfo() ? "" : "notes/";
    while (
      state.documents.some((d) => d.path === `${prefix}Untitled ${n}.md`)
    ) {
      n++;
    }
    if (state.documents.length >= 100) {
      notify("This preview supports up to 100 documents.");
      return;
    }
    const doc = documentFromText(
      `${prefix}Untitled ${n}.md`,
      `# Untitled ${n}\n\n`,
    );
    doc.savedContent = "";
    set("documents", (d) => [...d, doc]);
    open(doc.id);
    notify("Created a note draft. Save to keep it in the workspace.");
  }
  function newCode(path: string) {
    if (state.mode !== "develop") {
      throw new Error("Switch to Develop to create a code file");
    }
    const value = path.trim();
    if (
      !value || value.startsWith("/") || value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    ) throw new Error("Use a workspace-relative file path");
    if (/\.mdx?$/i.test(value)) {
      throw new Error("Switch to Knowledge to create a Markdown note");
    }
    if (state.documents.some((document) => document.path === value)) {
      throw new Error("A file with this path is already open");
    }
    if (state.documents.length >= 100) {
      throw new Error("This preview supports up to 100 documents.");
    }
    const doc = documentFromText(value, "");
    set("documents", (documents) => [...documents, doc]);
    open(doc.id);
    notify("Created a code draft. Save to keep it in the workspace.");
  }
  async function importFiles(files: File[]) {
    let bytes = state.documents.reduce(
      (sum, d) => sum + new TextEncoder().encode(d.content).length,
      0,
    );
    for (const file of files) {
      if (
        state.documents.length >= 100 || file.size > 256 * 1024 ||
        bytes + file.size > 1_000_000
      ) {
        notify(`Skipped ${file.name}: preview size limit reached.`);
        continue;
      }
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (content.includes("\0")) throw new Error("Binary file");
        let path = `Imported/${file.name}`, count = 1;
        while (state.documents.some((d) => d.id === path)) {
          path = `Imported/${count++}-${file.name}`;
        }
        const doc = documentFromText(path, content);
        set("documents", (d) => [...d, doc]);
        open(doc.id);
        bytes += file.size;
        notify(`Opened a local copy of ${file.name}`);
      } catch {
        notify(`Could not open ${file.name} as UTF-8 text.`);
      }
    }
  }
  const application = createWorkbenchApplication({
    documents: () => state.documents,
    knowledge: () => ({
      nodes: knowledge.notes(),
      edges: knowledge.edges(),
      truncated: knowledge.truncated(),
    }),
    active: activeTab,
    mode: () => state.mode,
    edit,
    open,
    layout,
    notify,
    bind: (id, diskVersion) => {
      set("documents", (d) => d.id === id, "diskVersion", diskVersion);
      schedule();
    },
    batch,
    create: (document) => {
      set("documents", (d) => [...d, document]);
      schedule();
    },
    close: (id) => {
      const group = state.groups.find((group) => group.id === state.activeGroup);
      const tab = state.tabs.find((tab) => tab.documentId === id && group?.tabs.includes(tab.id));
      if (tab) close(tab.id);
    },
    saved: (id, text) => {
      set("documents", (d) => d.id === id, "savedContent", text);
      schedule();
    },
    refresh: () => refreshContributions((n) => n + 1),
    select: (id, anchor, head) => {
      const viewId = state.activeTab;
      if (viewId) setRequestedSelection({ id, viewId, anchor, head, revision: ++selectionRevision });
    },
    language: (extensions, name) => {
      set(
        "documents",
        (d) => extensions.some((e) => d.path.endsWith(e)),
        "language",
        name,
      );
      schedule();
    },
    view: (view, remove) => {
      if (view.location !== "editor") return;
      const id = `view:${view.id}`;
      if (remove) close(id);
      else if (state.tabs.some((tab) => tab.id === id)) activate(id);
      else updateGroups(addView(state, { id, type: "custom" }));
    },
    output: (text) => setEvents((e) => [...e.slice(-49), text]),
  });
  const files = createWorkspaceFiles({
    state: () => state,
    request,
    checkpoint: prepareWorkspaceChange,
    persist: async () => {
      if (!persist()) throw new FileMoveError("Could not preserve the updated file identities.");
      if (workspaceInfo()) await recovery.checkpoint();
    },
    apply: (change) => {
      const active = activeDocument();
      const selection = active && application.selectionFor(active.id);
      const activeId = active && (change.ids.get(active.id) ?? active.id);
      workspaceGeneration++;
      batch(() => {
        set(reconcile(groupedSession(change.session)));
        application.remapDocuments(change.ids, change.removed);
        setDiskErrors({});
        const current = state.documents.find((doc) => doc.id === activeId);
        if (selection && current && state.activeTab) {
          setRequestedSelection({
            id: current.id,
            viewId: state.activeTab,
            anchor: Math.min(selection.anchor, current.content.length),
            head: Math.min(selection.head, current.content.length),
            revision: ++selectionRevision,
          });
        }
      });
      schedule();
      void knowledge.refresh();
    },
    open: openFile,
    check: checkDiskFiles,
    notify,
  });
  observeWorkspaceFiles({
    identity: () => diskConnected() ? workspaceInfo()?.id ?? null : null,
    request,
    changed: async () => {
      files.refresh();
      if (!files.busy()) await checkDiskFiles();
    },
    notify,
  });
  const checkOnFocus = () => {
    if (diskConnected()) void checkDiskFiles();
  };
  window.addEventListener("focus", checkOnFocus);
  const pagehide = () => persist();
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (
      !persist() ||
      (preferences.effective().confirmClose &&
        state.documents.some((d) =>
          (d.diskVersion || workspaceInfo()) && d.content !== d.savedContent
        ))
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => {
    for (const timer of autoSaveTimers.values()) clearTimeout(timer);
    persist();
    window.removeEventListener("focus", checkOnFocus);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("beforeunload", beforeUnload);
  });
  return {
    application,
    installations,
    files,
    knowledge,
    diskDocuments,
    preferences,
    workspaceInfo,
    diskConnected,
    diskErrors,
    prepareWorkspaceChange,
    connectHost,
    disconnectHost,
    request,
    openFile,
    reloadFile,
    checkDiskFiles,
    openSettings,
    createFile,
    newCode,
    contributionRevision,
    requestedSelection,
    viewEpoch,
    viewState,
    focusGroup,
    splitGroup,
    closeGroup,
    moveTab,
    resizeGroup,
    state,
    activity,
    setActivity,
    activeTab,
    activeDocument,
    message,
    storageError,
    events,
    open,
    openGraph,
    activate,
    close,
    edit,
    save,
    mode,
    layout,
    newNote,
    importFiles,
    notify,
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
