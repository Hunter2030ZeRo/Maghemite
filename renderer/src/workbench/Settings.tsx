import { createMemo, createSignal, For, Show } from "solid-js";
import {
  preferenceDefaults,
  type PreferenceKey,
  type PreferenceScope,
} from "../../../src/shared/preferences.ts";
import type { Workspace } from "../workspace/store";
import type { ThemeDefinition } from "../themes/registry";
import { Icon } from "../components/Icon";

const fields: {
  key: PreferenceKey;
  label: string;
  description: string;
  section: string;
  min?: number;
  max?: number;
}[] = [
  {
    key: "theme",
    label: "Color theme",
    description: "Colors, corners and default fonts from the selected theme.",
    section: "Appearance",
  },
  {
    key: "uiFont",
    label: "Interface font",
    description:
      "Font family or comma-separated fallbacks. Leave empty to follow the theme.",
    section: "Appearance",
  },
  {
    key: "editorFont",
    label: "Editor font",
    description:
      "A monospace font works best for source code. Empty follows the theme.",
    section: "Appearance",
  },
  {
    key: "noteFont",
    label: "Reading font",
    description: "Font used for Markdown body text. Empty follows the theme.",
    section: "Appearance",
  },
  {
    key: "editorFontSize",
    label: "Editor font size",
    description: "Text size in pixels.",
    section: "Editor",
    min: 10,
    max: 32,
  },
  {
    key: "editorLineHeight",
    label: "Editor line height",
    description: "Distance between source lines in pixels.",
    section: "Editor",
    min: 16,
    max: 48,
  },
  {
    key: "tabSize",
    label: "Tab size",
    description: "Spaces inserted by the Tab key.",
    section: "Editor",
    min: 1,
    max: 8,
  },
  {
    key: "wordWrap",
    label: "Word wrap",
    description: "Wrap long lines to fit the editor width.",
    section: "Editor",
  },
  {
    key: "lineNumbers",
    label: "Line numbers",
    description: "Show the source line gutter when word wrap is off.",
    section: "Editor",
  },
  {
    key: "noteFontSize",
    label: "Reading font size",
    description: "Markdown body text size in pixels.",
    section: "Notes",
    min: 10,
    max: 28,
  },
  {
    key: "noteView",
    label: "Open notes in",
    description: "The initial view for newly opened notes.",
    section: "Notes",
  },
  {
    key: "autoSave",
    label: "Auto save",
    description:
      "Save modified disk files after a delay. New drafts require their first manual save.",
    section: "Files",
  },
  {
    key: "autoSaveDelay",
    label: "Auto save delay",
    description:
      "Milliseconds after typing stops. Disk conflicts always stop saving.",
    section: "Files",
    min: 500,
    max: 30000,
  },
  {
    key: "confirmClose",
    label: "Confirm before closing",
    description:
      "Warn when disk files contain unsaved edits. Recovery drafts remain available.",
    section: "Files",
  },
];

export function Settings(
  props: { workspace: Workspace; themes: readonly ThemeDefinition[] },
) {
  const prefs = props.workspace.preferences;
  const [scope, setScope] = createSignal<PreferenceScope>("user");
  const [search, setSearch] = createSignal("");
  const layer = () =>
    scope() === "user" ? prefs.user().values : prefs.workspace().values;
  const values = () => ({
    ...preferenceDefaults,
    ...prefs.user().values,
    ...(scope() === "workspace" ? prefs.workspace().values : {}),
  });
  const visible = createMemo(() =>
    fields.filter((f) =>
      `${f.label} ${f.description} ${f.section}`.toLowerCase().includes(
        search().toLowerCase(),
      )
    )
  );
  const disabled = () =>
    prefs.busy() || (prefs.desktop() && !prefs.connected());
  const update = (
    key: PreferenceKey,
    value: string | number | boolean | undefined,
  ) => void prefs.update(key, value, scope());
  return (
    <div class="settings-page">
      <header class="settings-header">
        <div>
          <span class="eyebrow">WORKSPACE PREFERENCES</span>
          <h1>Settings</h1>
          <p>Make this workspace feel familiar.</p>
        </div>
        <Icon name="settings" />
      </header>
      <div class="settings-controls">
        <div class="view-switch" aria-label="Settings scope">
          <button
            aria-pressed={scope() === "user"}
            classList={{ active: scope() === "user" }}
            onClick={() => setScope("user")}
          >
            User
          </button>
          <button
            disabled={!props.workspace.workspaceInfo()}
            aria-pressed={scope() === "workspace"}
            classList={{ active: scope() === "workspace" }}
            onClick={() => setScope("workspace")}
          >
            Workspace
          </button>
        </div>
        <label class="search-field">
          <Icon name="search" />
          <input
            aria-label="Search settings"
            placeholder="Search settings…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
      </div>
      <p class="settings-scope-copy">
        {scope() === "workspace"
          ? `Overrides for ${props.workspace.workspaceInfo()?.label}. Reset a setting to inherit your user preference.`
          : prefs.desktop()
          ? "Your defaults for every project. Workspace settings take precedence."
          : "Preferences for this browser preview. Desktop preferences are stored by the application."}
      </p>
      <Show when={prefs.error()}>
        <p class="settings-error" role="alert">{prefs.error()}</p>
      </Show>
      <Show when={prefs.desktop() && !prefs.connected()}>
        <p role="status">Desktop disconnected. Reconnect to save settings.</p>
      </Show>
      <For each={["Appearance", "Editor", "Notes", "Files"]}>
        {(section) => (
          <Show when={visible().some((f) => f.section === section)}>
            <section class="settings-section">
              <h2>{section}</h2>
              <For
                each={visible().filter((f) => f.section === section)}
              >
                {(field) => (
                  <div class="setting-row">
                    <div class="setting-description">
                      <label for={`setting-${field.key}`}>{field.label}</label>
                      <p>{field.description}</p>
                      <Show
                        when={scope() === "user" &&
                          Object.hasOwn(prefs.workspace().values, field.key)}
                      >
                        <small>Overridden in this workspace</small>
                      </Show>
                    </div>
                    <div class="setting-control">
                      <Show
                        when={field.key === "theme"}
                        fallback={
                          <Show
                            when={field.key === "noteView"}
                            fallback={
                              <Show
                                when={typeof preferenceDefaults[field.key] ===
                                  "boolean"}
                                fallback={
                                  <input
                                    id={`setting-${field.key}`}
                                    type={field.min !== undefined
                                      ? "number"
                                      : "text"}
                                    min={field.min}
                                    max={field.max}
                                    step="1"
                                    maxLength={200}
                                    placeholder="Theme default"
                                    value={String(values()[field.key])}
                                    disabled={disabled()}
                                    onChange={(e) => {
                                      if (e.currentTarget.checkValidity()) {
                                        update(
                                          field.key,
                                          field.min !== undefined
                                            ? e.currentTarget.valueAsNumber
                                            : e.currentTarget.value,
                                        );
                                      } else e.currentTarget.reportValidity();
                                    }}
                                  />
                                }
                              >
                                <input
                                  id={`setting-${field.key}`}
                                  type="checkbox"
                                  checked={!!values()[field.key]}
                                  disabled={disabled()}
                                  onChange={(e) =>
                                    update(field.key, e.currentTarget.checked)}
                                />
                              </Show>
                            }
                          >
                            <select
                              id={`setting-${field.key}`}
                              value={values().noteView}
                              disabled={disabled()}
                              onChange={(e) =>
                                update(field.key, e.currentTarget.value)}
                            >
                              <option value="read">Read</option>
                              <option value="edit">Edit</option>
                            </select>
                          </Show>
                        }
                      >
                        <select
                          id={`setting-${field.key}`}
                          value={values().theme}
                          disabled={disabled()}
                          onChange={(e) =>
                            update(field.key, e.currentTarget.value)}
                        >
                          <For each={props.themes}>
                            {(theme) => (
                              <option value={theme.id}>{theme.name}</option>
                            )}
                          </For>
                        </select>
                      </Show>
                      <button
                        class="setting-reset"
                        disabled={disabled() ||
                          !Object.hasOwn(layer(), field.key)}
                        aria-label={`Reset ${field.label}`}
                        onClick={() => update(field.key, undefined)}
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </section>
          </Show>
        )}
      </For>
      <Show when={!visible().length}>
        <p>No settings match your search.</p>
      </Show>
      <footer class="settings-footer">
        {prefs.busy() ? "Saving…" : "Changes apply immediately."}
      </footer>
    </div>
  );
}
