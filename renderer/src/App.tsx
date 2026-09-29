import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Icon, IconButton, type IconName } from "./components/Icon";
import { ResizeHandle } from "./components/ResizeHandle";
import { createWorkspace } from "./workspace/store";
import { type Activity, filename } from "./workspace/model";
import { Sidebar } from "./workbench/Sidebar";
import { Inspector } from "./workbench/Inspector";
import { EditorGroups } from "./workbench/EditorGroups";
import { OpenFolder } from "./workbench/OpenFolder";
import type { PreferenceSnapshot } from "../../src/shared/preferences.ts";
import { BottomPanel } from "./workbench/BottomPanel";
import { type Command, CommandPalette } from "./workbench/CommandPalette";
import { applyTheme } from "./themes/apply";
import {
  DEFAULT_THEME_ID,
  getTheme,
  type ThemeDefinition,
  type ThemeId,
  themes,
} from "./themes/registry";
import { fetchThemeCatalog } from "./themes/catalog";
import { connectModules, type ModuleCommand } from "./workspace/modules";
import { createAttachmentResourceReporter } from "./workspace/attachments";
import { ModuleViews } from "./workbench/ModuleViews";
import type { Json } from "../../modules-sdk/js/mod.ts";
import "./App.css";

export default function App(props: { initialThemeId?: ThemeId } = {}) {
  const w = createWorkspace();
  const [moduleCommands, setModuleCommands] = createSignal<ModuleCommand[]>([]);
  const [modulesConnected, setModulesConnected] = createSignal(false);
  const [terminalAction, setTerminalAction] = createSignal({
    id: 0,
    create: false,
  });
  const showTerminal = (create = false) => {
    w.layout({
      bottom: true,
      bottomHeight: Math.max(240, w.state.layout.bottomHeight),
    });
    setTerminalAction((action) => ({ id: action.id + 1, create }));
  };
  let moduleConnection: ReturnType<typeof connectModules> | undefined;
  const attachmentResources = createAttachmentResourceReporter(
    (method, parameters) => moduleConnection!.request(method, parameters),
    (error) => w.notify(`Attachment resource report failed: ${String(error)}`),
  );
  const executeModule = (command: string, input: Json) => {
    void moduleConnection?.execute(command, input).catch((e) =>
      w.notify(String(e))
    );
  };
  const [palette, setPalette] = createSignal(false);
  const [folderDialog, setFolderDialog] = createSignal(false);
  const [changingFolder, setChangingFolder] = createSignal(false);
  function openFolder() {
    setPalette(false);
    setDrawer(null);
    setFolderDialog(true);
  }

  const themeId = () => w.preferences.effective().theme;
  if (props.initialThemeId) {
    void w.preferences.update("theme", props.initialThemeId, "user");
  }
  const [availableThemes, setAvailableThemes] = createSignal<
    readonly ThemeDefinition[]
  >(themes);
  const theme = createMemo(() => getTheme(themeId(), availableThemes()));
  const catalogUrl = import.meta.env.VITE_THEME_CATALOG_URL as
    | string
    | undefined;
  let catalogRequest: AbortController | undefined;
  let catalogGeneration = 0;
  async function refreshThemes() {
    if (!catalogUrl) return;
    catalogRequest?.abort();
    const generation = ++catalogGeneration;
    catalogRequest = new AbortController();
    try {
      const available = await fetchThemeCatalog(
        catalogUrl,
        AbortSignal.any([
          catalogRequest.signal,
          AbortSignal.timeout(5000),
        ]),
      );
      if (generation !== catalogGeneration) return;
      setAvailableThemes(available);
      if (!available.some((entry) => entry.id === themeId())) {
        void w.preferences.update("theme", DEFAULT_THEME_ID, "user");
        w.notify(
          "The selected theme is no longer available. Graphite applied.",
        );
      }
    } catch {
      if (generation === catalogGeneration) {
        w.notify(
          "Could not refresh module themes. Current appearance kept; try Refresh module themes.",
        );
      }
    }
  }
  onMount(() => {
    const changed = () => void refreshThemes();
    window.addEventListener("maghemite:modules-changed", changed);
    onCleanup(() =>
      window.removeEventListener("maghemite:modules-changed", changed)
    );
    void refreshThemes();
    if (catalogUrl) {
      moduleConnection = connectModules({
        invoke: w.application.invoke,
        internal: async (method, parameters, owner) => {
          if (method === "workspace.checkpoint") {
            await w.prepareWorkspaceChange();
            return null;
          }
          if (method.startsWith("files.")) return await w.files.internal(method, parameters);
          return w.application.internal(method, parameters, owner);
        },
        release: w.application.release,
        reset: () => {
          attachmentResources.stop();
          w.application.reset();
          w.disconnectHost();
        },
        ready: async () => {
          await attachmentResources.start();
          const info = await moduleConnection!.request(
            "workspace.info",
          ) as unknown as {
            workspace: { id: string; label: string; path: string } | null;
            preferences: PreferenceSnapshot | null;
          };
          await w.connectHost(
            info.workspace,
            (method, parameters, signal) =>
              moduleConnection!.request(method, parameters, signal),
          );
          if (info.preferences) {
            w.preferences.connect(
              info.preferences,
              (parameters) =>
                moduleConnection!.request("preferences.update", parameters),
            );
          }
          await w.checkDiskFiles();
          setChangingFolder(false);
        },
        catalog: setModuleCommands,
        installations: w.installations.receive,
        exposed: () => window.dispatchEvent(new Event("maghemite:modules-changed")),
        status: setModulesConnected,
        notify: w.notify,
      });
      w.application.onEvent((...args) => moduleConnection?.event(...args));
    }
  });
  onCleanup(() => {
    attachmentResources.stop();
    moduleConnection?.close();
    catalogGeneration++;
    catalogRequest?.abort();
  });
  const [paletteKind, setPaletteKind] = createSignal<"commands" | "themes">(
    "commands",
  );
  createEffect(() => {
    const root = document.documentElement, settings = w.preferences.effective();
    applyTheme(theme(), root);
    for (
      const [token, value] of [["--font-ui", settings.uiFont], [
        "--font-code",
        settings.editorFont,
      ], ["--font-note", settings.noteFont]]
    ) {
      if (value) root.style.setProperty(token, value);
    }
    root.style.setProperty(
      "--editor-font-size",
      `${settings.editorFontSize}px`,
    );
    root.style.setProperty(
      "--editor-line-height",
      `${settings.editorLineHeight}px`,
    );
    root.style.setProperty("--note-font-size", `${settings.noteFontSize}px`);
  });
  function showPalette(kind: "commands" | "themes" = "commands") {
    setPaletteKind(kind);
    setPalette(true);
  }
  function chooseTheme(id: ThemeId) {
    void w.preferences.update(
      "theme",
      id,
      Object.hasOwn(w.preferences.workspace().values, "theme")
        ? "workspace"
        : "user",
    );
  }
  const themeCommands = createMemo<Command[]>(() =>
    availableThemes().map((preset) => ({
      id: `theme-${preset.id}`,
      label: preset.name,
      detail: `${preset.description}${
        preset.id === theme().id ? " · Current theme" : ""
      }`,
      icon: preset.id === theme().id ? "check" : "sun",
      run: () => chooseTheme(preset.id),
    }))
  );
  const [cursor, setCursor] = createSignal("");
  const [compact, setCompact] = createSignal(window.innerWidth < 1050);
  const [drawer, setDrawer] = createSignal<"primary" | "secondary" | null>(
    null,
  );
  let filePicker!: HTMLInputElement;
  const primary = () =>
    compact() ? drawer() === "primary" : w.state.layout.primary;
  const secondary = () =>
    compact() ? drawer() === "secondary" : w.state.layout.secondary;
  createEffect(() => {
    const id = w.state.activeTab;
    queueMicrotask(() => {
      if (id) {
        document.getElementById(`tab-${id}`)?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      }
    });
  });
  function toggle(side: "primary" | "secondary") {
    if (compact()) setDrawer((d) => d === side ? null : side);
    else w.layout({ [side]: !w.state.layout[side] });
  }
  function selectActivity(activity: Activity) {
    w.setActivity(activity);
    if (compact()) setDrawer("primary");
    else w.layout({ primary: true });
  }
  function openSearch() {
    selectActivity("search");
    queueMicrotask(() =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search workspace"]',
      )?.focus()
    );
  }
  function jump(line: number) {
    const doc = w.activeDocument();
    if (!doc) return;
    const offset = Math.min(
      doc.content.length,
      doc.content.split("\n").slice(0, Math.max(0, line - 1)).reduce(
        (n, text) => n + text.length + 1,
        0,
      ),
    );
    const data = w.application.invoke(
      "documents.read",
      { id: doc.id },
      "maghemite.workbench",
    ) as { document: { version: string } };
    w.application.invoke("editor.setSelection", {
      id: doc.id,
      version: data.document.version,
      anchor: offset,
      head: offset,
    }, "maghemite.workbench");
  }
  function openDocument(id: string, line?: number) {
    w.open(id);
    setDrawer(null);
    setCursor("");
    if (line) queueMicrotask(() => jump(line));
  }
  function newNote() {
    w.newNote();
    setDrawer(null);
  }
  const commands = createMemo<Command[]>(() => [
    {
      id: "split-editor",
      label: "Split editor group",
      detail: "Copy the current document into an independent view",
      icon: "right",
      shortcut: "Ctrl \\",
      run: () => w.splitGroup(),
    },
    {
      id: "focus-next-group",
      label: "Focus next editor group",
      detail: "Keep each view's cursor and scrolling",
      icon: "arrow",
      run: () => {
        const index = w.state.groups.findIndex((group) => group.id === w.state.activeGroup);
        const next = w.state.groups[(index + 1) % w.state.groups.length];
        w.focusGroup(next.id);
        queueMicrotask(() => document.getElementById(next.id)?.focus());
      },
    },
    {
      id: "move-editor-tab",
      label: "Move current tab to next group",
      detail: "Move the view without closing the document",
      icon: "arrow",
      run: () => {
        const index = w.state.groups.findIndex((group) => group.id === w.state.activeGroup);
        const next = w.state.groups[(index + 1) % w.state.groups.length];
        if (w.state.activeTab) w.moveTab(w.state.activeTab, next.id);
      },
    },
    {
      id: "close-editor-group",
      label: "Close editor group and keep tabs",
      detail: "Collect this group's views in its neighbor",
      icon: "close",
      run: () => w.closeGroup(),
    },
    {
      id: "search-workspace",
      label: "Search workspace files",
      detail: "Find text in code and notes, including unopened files",
      icon: "search",
      shortcut: "Ctrl Shift F",
      run: openSearch,
    },
    {
      id: "open-folder",
      label: "Open folder…",
      detail: "Open a project or notebook from disk",
      icon: "folder",
      shortcut: "Ctrl Shift O",
      run: openFolder,
    },
    {
      id: "settings",
      label: "Open settings",
      detail: "User and workspace preferences",
      icon: "settings",
      shortcut: "Ctrl ,",
      run: w.openSettings,
    },
    {
      id: "reload-file",
      label: "Reload current file from disk",
      detail: "Review external changes",
      icon: "refresh",
      run: () => {
        const id = w.activeDocument()?.id;
        if (id) void w.reloadFile(id);
      },
    },
    {
      id: "undo-module-edit",
      label: "Undo last module edit",
      detail: "Workspace",
      icon: "code",
      run: () => {
        try {
          w.application.undo();
        } catch (error) {
          w.notify(String(error));
        }
      },
    },
    ...moduleCommands().map((command): Command => ({
      id: `module:${command.id}`,
      label: command.title,
      detail: command.moduleId,
      icon: "modules",
      run: () => {
        void moduleConnection?.execute(command.id).then(
          () => w.notify(`Completed: ${command.title}`),
          (error) => w.notify(String(error)),
        );
      },
    })),
    {
      id: "new",
      label: "Create a new note",
      detail: "Workspace",
      icon: "plus",
      run: newNote,
    },
    {
      id: "open",
      label: "Open text files…",
      detail: "Import local copies into this browser workspace",
      icon: "folder",
      run: () => filePicker.click(),
    },
    {
      id: "save",
      label: "Save current file",
      detail: w.workspaceInfo() ? "Save to disk" : "Save in this browser",
      icon: "save",
      shortcut: "Ctrl S",
      run: () => {
        void w.save();
      },
    },
    {
      id: "graph",
      label: "Open knowledge graph",
      detail: "Connections between your notes",
      icon: "graph",
      run: w.openGraph,
    },
    {
      id: "develop",
      label: "Switch to Develop",
      detail: "Keep all documents and drafts open",
      icon: "code",
      run: () => w.mode("develop"),
    },
    {
      id: "knowledge",
      label: "Switch to Knowledge",
      detail: "Keep all documents and drafts open",
      icon: "book",
      run: () => w.mode("knowledge"),
    },
    {
      id: "sidebar",
      label: "Toggle explorer",
      detail: "Layout",
      icon: "left",
      shortcut: "Ctrl B",
      run: () => toggle("primary"),
    },
    {
      id: "context",
      label: "Toggle document context",
      detail: "Layout",
      icon: "right",
      run: () => toggle("secondary"),
    },
    {
      id: "panel",
      label: "Toggle bottom panel",
      detail: "Layout",
      icon: "bottom",
      shortcut: "Ctrl J",
      run: () => w.layout({ bottom: !w.state.layout.bottom }),
    },
    {
      id: "terminal",
      label: "Focus terminal",
      detail: "Workspace shell",
      icon: "terminal",
      shortcut: "Ctrl `",
      run: () => showTerminal(),
    },
    {
      id: "new-terminal",
      label: "New terminal",
      detail: "Workspace shell",
      icon: "terminal",
      shortcut: "Ctrl Shift `",
      run: () => showTerminal(true),
    },
    {
      id: "theme",
      label: "Choose color theme…",
      detail: "Appearance",
      icon: "sun",
      run: () => showPalette("themes"),
    },
    ...themeCommands().map((command) => ({
      ...command,
      label: `Theme: ${command.label}`,
    })),
    ...(catalogUrl
      ? [{
        id: "refresh-themes",
        label: "Refresh module themes",
        detail: "Appearance",
        icon: "sun" as const,
        run: () => {
          void refreshThemes();
        },
      }]
      : []),
    ...w.state.documents.map((doc, index): Command => ({
      id: `file-${index}`,
      label: filename(doc.path),
      detail: doc.path,
      icon: doc.kind === "note" ? "notes" : "code",
      run: () => openDocument(doc.id),
    })),
  ]);
  const keydown = (e: KeyboardEvent) => {
    if (w.files.busy()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.isComposing || folderDialog() || changingFolder()) return;
    if ((e.ctrlKey || e.metaKey) && e.code === "Backquote") {
      e.preventDefault();
      e.stopPropagation();
      if (
        !e.shiftKey && (e.target as HTMLElement)?.closest?.(".xterm") &&
        w.state.layout.bottom
      ) w.layout({ bottom: false });
      else showTerminal(e.shiftKey);
      return;
    }
    // Shell control sequences (Ctrl+C/D/K/J, etc.) belong to the focused terminal.
    if ((e.target as HTMLElement)?.closest?.(".xterm")) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      e.stopPropagation();
      openFolder();
      return;
    }
    if (e.key === "Escape") {
      setPalette(false);
      setDrawer(null);
    }
    if (!e.ctrlKey && !e.metaKey) return;
    const key = e.key.toLowerCase();
    if (["k", "p", "s", "b", "j", ","].includes(key)) e.stopPropagation();
    if (key === "k" || key === "p") {
      e.preventDefault();
      showPalette();
    }
    if (palette()) return;
    if (key === "\\") {
      e.preventDefault();
      e.stopPropagation();
      w.splitGroup();
    }
    if (key === ",") {
      e.preventDefault();
      w.openSettings();
    }
    if (key === "s") {
      e.preventDefault();
      w.save();
    }
    if (key === "b") {
      e.preventDefault();
      toggle("primary");
    }
    if (key === "j") {
      e.preventDefault();
      w.layout({ bottom: !w.state.layout.bottom });
    }
  };
  const resize = () => {
    setCompact(window.innerWidth < 1050);
    setDrawer(null);
  };
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("resize", resize);
  onCleanup(() => {
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("resize", resize);
  });
  const activities: { id: Activity; name: IconName; label: string }[] = [
    { id: "files", name: "files", label: "Explorer" },
    { id: "search", name: "search", label: "Search" },
    { id: "notes", name: "notes", label: "Notes" },
    { id: "modules", name: "modules", label: "Modules" },
  ];
  return (
    <div class="app-shell" data-theme={theme().id}>
      <a class="skip-link" href="#editor-area">Skip to editor</a>
      <header class="titlebar">
        <div class="app-brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 21 7v10l-9 5-9-5V7z" />
            <path d="m7 16 0-8 5 5 5-5v8" />
          </svg>
          <span>Maghemite</span>
          <span class="preview-badge">preview</span>
        </div>
        <button class="command-trigger" onClick={() => showPalette()}>
          <Icon name="search" />
          <span>Search or run a command…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div class="layout-controls">
          <IconButton
            name="left"
            label="Toggle primary sidebar"
            active={primary()}
            onClick={() => toggle("primary")}
          />
          <IconButton
            name="bottom"
            label="Toggle bottom panel"
            active={w.state.layout.bottom}
            onClick={() => w.layout({ bottom: !w.state.layout.bottom })}
          />
          <IconButton
            name="right"
            label="Toggle document context"
            active={secondary()}
            onClick={() => toggle("secondary")}
          />
        </div>
      </header>
      <div class="perspective-bar">
        <div class="workspace-identity">
          <button
            class="workspace-folder-button"
            onClick={openFolder}
            title="Open folder (Ctrl+Shift+O)"
            aria-label="Open folder…"
          >
            <Icon name="folder" />
            <span>Open folder</span>
          </button>
          <span>Maghemite</span>
          <span class="sample-badge">
            {w.workspaceInfo()?.label ?? "Sample workspace"}
          </span>
        </div>
        <div class="perspective-switch" aria-label="Workspace perspective">
          <button
            aria-pressed={w.state.mode === "develop"}
            classList={{ active: w.state.mode === "develop" }}
            onClick={() => w.mode("develop")}
          >
            <Icon name="code" />Develop
          </button>
          <button
            aria-pressed={w.state.mode === "knowledge"}
            classList={{ active: w.state.mode === "knowledge" }}
            onClick={() => w.mode("knowledge")}
          >
            <Icon name="book" />Knowledge
          </button>
        </div>
        <span class="local-hint">
          <span class="sample-dot" />
          {w.workspaceInfo()
            ? (w.diskConnected()
              ? "Disk workspace"
              : "Disconnected · drafts retained")
            : "Drafts stay in this browser"}
        </span>
      </div>
      <Show when={w.storageError()}>
        <div class="storage-warning" role="alert">
          Browser storage is unavailable or full. Download edited files before
          closing this page.
        </div>
      </Show>
      <div
        inert={changingFolder()}
        class="workbench"
        data-primary={primary()}
        data-secondary={secondary()}
        style={{
          "--primary-width": `${w.state.layout.primaryWidth}px`,
          "--secondary-width": `${w.state.layout.secondaryWidth}px`,
        }}
      >
        <nav class="activity-bar" aria-label="Workspace navigation">
          <div class="activities">
            <For each={activities}>
              {(item) => (
                <button
                  aria-label={item.label}
                  title={item.label}
                  aria-pressed={w.activity() === item.id}
                  classList={{ active: w.activity() === item.id }}
                  onClick={() => selectActivity(item.id)}
                >
                  <Icon name={item.name} />
                </button>
              )}
            </For>
            <button
              aria-label="Knowledge graph"
              title="Knowledge graph"
              aria-pressed={w.activeTab()?.type === "graph"}
              onClick={w.openGraph}
            >
              <Icon name="graph" />
            </button>
          </div>
          <div class="activity-bottom">
            <IconButton
              name="settings"
              label="Settings (Ctrl+,)"
              active={w.activeTab()?.type === "settings"}
              onClick={w.openSettings}
            />
            <IconButton
              name="sun"
              label="Choose theme"
              onClick={() => showPalette("themes")}
            />
            <button
              class="profile-mark"
              title="Local workspace"
              aria-label="Local workspace information"
              onClick={() =>
                w.notify(
                  w.workspaceInfo()?.path ??
                    "Local preview · drafts stay in this browser",
                )}
            >
              M
            </button>
          </div>
        </nav>
        <Show when={compact() && drawer()}>
          <button
            class="drawer-backdrop"
            aria-label="Close sidebar overlay"
            onClick={() => setDrawer(null)}
          />
        </Show>
        <Show when={primary()}>
          <div class="primary-region">
            <Sidebar
              workspace={w}
              modulesConnected={modulesConnected()}
              moduleCommandCount={moduleCommands().length}
              openFolder={openFolder}
              pickFiles={() => filePicker.click()}
              openDocument={openDocument}
              newNote={newNote}
            />
            <ModuleViews
              workspace={w}
              location="primary"
              execute={executeModule}
            />
            <ResizeHandle
              label="Resize primary sidebar"
              orientation="vertical"
              value={w.state.layout.primaryWidth}
              min={190}
              max={360}
              onChange={(primaryWidth) => w.layout({ primaryWidth })}
            />
          </div>
        </Show>
        <main
          class="editor-region"
          id="editor-area"
          tabindex="-1"
          aria-label="Editor workspace"
        >
          <EditorGroups workspace={w} themes={availableThemes()} onCreate={newNote}
            showPalette={() => showPalette()} setCursor={setCursor} execute={executeModule} />
          <BottomPanel
            workspace={w}
            terminalConnected={modulesConnected()}
            terminalAction={terminalAction()}
            terminal={(action, parameters) =>
              moduleConnection!.terminal(action, parameters)}
            execute={executeModule}
          />
        </main>
        <Show when={secondary()}>
          <div class="secondary-region">
            <ResizeHandle
              label="Resize document context"
              orientation="vertical"
              reverse
              value={w.state.layout.secondaryWidth}
              min={210}
              max={360}
              onChange={(secondaryWidth) => w.layout({ secondaryWidth })}
            />
            <Inspector workspace={w} jump={jump} />
            <ModuleViews
              workspace={w}
              location="secondary"
              execute={executeModule}
            />
          </div>
        </Show>
      </div>
      <footer class="statusbar">
        <button
          class="connection-status"
          onClick={() =>
            w.notify(
              modulesConnected()
                ? "Modules are connected. Disk and tool services depend on the desktop configuration."
                : w.workspaceInfo()
                ? "Desktop disconnected. Drafts are retained; reconnect to save disk files."
                : "Local preview. Module host, filesystem and terminal are not connected.",
            )}
        >
          <span class="sample-dot" />
          {modulesConnected()
            ? "Modules connected"
            : w.workspaceInfo()
            ? "Desktop disconnected"
            : "Local preview"}
        </button>
        <span class="status-message" role="status" aria-live="polite">
          {w.message()}
        </span>
        <span class="status-document">
          {cursor()}
          <span>{w.activeDocument()?.language ?? "Workspace"}</span>
          <span>UTF-8</span>
        </span>
        <button
          title="Open command palette"
          aria-label="Open command palette"
          onClick={() => showPalette()}
        >
          <Icon name="command" />
        </button>
      </footer>
      <input
        class="file-picker"
        type="file"
        multiple
        ref={(element) => {
          filePicker = element;
        }}
        aria-label="Import text files"
        accept=".md,.mdx,.txt,.ts,.tsx,.js,.jsx,.json,.rs,.py,.css,.html,.toml,.yaml,.yml"
        onChange={(e) => {
          void w.importFiles([...e.currentTarget.files ?? []]);
          e.currentTarget.value = "";
          setDrawer(null);
        }}
      />
      <Show when={folderDialog()}>
        <OpenFolder
          current={w.workspaceInfo()?.path}
          connected={modulesConnected()}
          request={(method, parameters) =>
            moduleConnection
              ? moduleConnection.request(method, parameters)
              : Promise.reject(new Error("Desktop unavailable"))}
          close={() => setFolderDialog(false)}
          opened={(changed, warning) => {
            setChangingFolder(changed);
            setFolderDialog(false);
            if (warning) w.notify(warning);
          }}
        />
      </Show>
      <Show when={changingFolder()}>
        <div class="folder-switch-overlay" role="status" aria-live="polite">
          Opening workspace…
        </div>
      </Show>
      <Show when={w.files.busy()}>
        <div class="folder-switch-overlay" role="status" aria-live="polite">
          Updating files and preserving drafts…
        </div>
      </Show>
      <Show when={palette()}>
        <CommandPalette
          commands={paletteKind() === "themes" ? themeCommands() : commands()}
          initialSelectedId={paletteKind() === "themes"
            ? `theme-${theme().id}`
            : undefined}
          label={paletteKind() === "themes" ? "Choose theme" : undefined}
          placeholder={paletteKind() === "themes"
            ? "Choose colors, corners, and fonts…"
            : undefined}
          close={() => setPalette(false)}
        />
      </Show>
    </div>
  );
}
