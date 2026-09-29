import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { IconButton } from "../components/Icon";
import type { Json } from "../../../modules-sdk/js/mod.ts";

type Session = {
  session: string;
  profile: string;
  done?: boolean;
  exitCode?: number | null;
};
type View = {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  cursor: number;
  webgl?: WebglAddon;
  loss?: { dispose(): void };
  fallback: boolean;
  size: string;
  ended: boolean;
  disposed: boolean;
  acknowledge?: () => void;
};
export type TerminalAction = { id: number; create: boolean };
export function TerminalPanel(props: {
  request(action: string, parameters: Json): Promise<Json>;
  active: boolean;
  connected: boolean;
  workspaceId?: string;
  action?: TerminalAction;
}) {
  let surface!: HTMLDivElement;
  const views = new Map<string, View>();
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [selected, setSelected] = createSignal("");
  const [error, setError] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  let closed = false, reading = false, sending = false, lastList = 0, epoch = 0;
  let autoStarted = false, lastAction = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const input: { session: string; text: string }[] = [];
  const active = () => props.active && props.connected && !closed;
  function releaseGpu(view: View) {
    view.loss?.dispose();
    view.loss = undefined;
    const addon = view.webgl;
    view.webgl = undefined;
    addon?.dispose();
    view.element.dataset.renderer = "dom";
  }
  function dispose(view: View) {
    view.disposed = true;
    view.acknowledge?.();
    releaseGpu(view);
    view.terminal.dispose();
    view.element.remove();
  }
  function theme(view: View) {
    const style = getComputedStyle(document.documentElement);
    view.terminal.options.theme = {
      background: style.getPropertyValue("--bg").trim(),
      foreground: style.getPropertyValue("--text").trim(),
      cursor: style.getPropertyValue("--accent").trim(),
      selectionBackground: style.getPropertyValue("--selection").trim(),
    };
    view.terminal.options.fontFamily =
      style.getPropertyValue("--font-code").trim() || "monospace";
  }
  function resize(id: string, view: View) {
    if (
      !active() || id !== selected() || !surface.clientWidth ||
      !surface.clientHeight
    ) return;
    view.fit.fit();
    const columns = Math.min(500, Math.max(2, view.terminal.cols));
    const rows = Math.min(300, Math.max(2, view.terminal.rows));
    const size = `${columns}:${rows}`;
    if (size === view.size || view.ended) return;
    view.size = size;
    void props.request("resize", { session: id, columns, rows }).catch((e) => {
      view.size = "";
      if (!closed && !view.disposed) setError(String(e));
    });
  }
  async function flushInput() {
    if (sending) return;
    sending = true;
    try {
      while (input.length && !closed) {
        const item = input.shift()!;
        await props.request("write", item);
      }
      wake();
    } catch (e) {
      input.length = 0;
      if (!closed) setError(String(e));
    } finally {
      sending = false;
    }
  }
  function viewFor(id: string) {
    let view = views.get(id);
    if (view) return view;
    const element = document.createElement("div");
    element.className = "terminal-view";
    surface.append(element);
    const terminal = new Terminal({
      fontSize: 12,
      scrollback: 2000,
      convertEol: false,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    view = {
      terminal,
      fit,
      element,
      cursor: 0,
      fallback: false,
      size: "",
      ended: false,
      disposed: false,
    };
    views.set(id, view);
    theme(view);
    terminal.loadAddon(fit);
    terminal.open(element);
    terminal.attachCustomKeyEventHandler((event) =>
      !((event.ctrlKey || event.metaKey) && event.code === "Backquote")
    );
    terminal.textarea?.setAttribute("aria-label", "Terminal input");
    terminal.onData((text) => {
      if (closed || !active() || view!.ended) return;
      if (input.reduce((n, p) => n + p.text.length, 0) + text.length > 65536) {
        setError("Terminal input queue is full");
        return;
      }
      while (text) {
        let end = Math.min(4096, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        input.push({ session: id, text: text.slice(0, end) });
        text = text.slice(end);
      }
      void flushInput();
    });
    return view;
  }
  function showSelected(focus = false) {
    if (!ready() || closed) return;
    for (const [id, view] of views) {
      view.element.hidden = id !== selected() || !active();
      if (view.element.hidden) releaseGpu(view);
    }
    if (!active() || !selected()) return;
    const id = selected(), view = viewFor(id);
    view.element.hidden = false;
    if (!view.webgl && !view.fallback) {
      const addon = new WebglAddon();
      try {
        view.terminal.loadAddon(addon);
        view.webgl = addon;
        view.element.dataset.renderer = "webgl";
        view.loss = addon.onContextLoss(() => {
          view.fallback = true;
          releaseGpu(view);
          if (!view.disposed) view.terminal.refresh(0, view.terminal.rows - 1);
        });
      } catch {
        addon.dispose();
        view.fallback = true;
        view.element.dataset.renderer = "dom";
      }
    }
    resize(id, view);
    if (focus) view.terminal.focus();
  }
  function choose(id: string) {
    setSelected(id);
    queueMicrotask(() => {
      showSelected(true);
      wake();
    });
  }
  async function create() {
    if (creating() || !props.connected || closed) return;
    setCreating(true);
    autoStarted = true;
    const generation = epoch;
    try {
      const current = views.get(selected());
      const result = await props.request("create", {
        columns: Math.min(500, Math.max(2, current?.terminal.cols ?? 80)),
        rows: Math.min(300, Math.max(2, current?.terminal.rows ?? 24)),
      }) as Session;
      if (closed || epoch !== generation) return;
      setSessions((old) => [
        ...old.filter((s) => s.session !== result.session),
        result,
      ]);
      setError("");
      choose(result.session);
      lastList = 0;
    } catch (e) {
      if (!closed && epoch === generation) setError(String(e));
    } finally {
      if (!closed) setCreating(false);
    }
  }
  async function closeSelected() {
    const id = selected();
    if (!id) return;
    try {
      await props.request("close", { session: id });
      if (closed) return;
      const view = views.get(id);
      if (view) dispose(view);
      views.delete(id);
      for (let i = input.length - 1; i >= 0; i--) {
        if (input[i].session === id) input.splice(i, 1);
      }
      setSessions((old) => old.filter((s) => s.session !== id));
      choose(sessions()[0]?.session ?? "");
      setError("");
      lastList = 0;
    } catch (e) {
      if (!closed) setError(String(e));
    }
  }
  function wake() {
    clearTimeout(timer);
    if (active() && ready() && !reading) timer = setTimeout(poll, 0);
  }
  async function poll() {
    if (!active() || reading) return;
    reading = true;
    const generation = epoch;
    let delay = 100;
    try {
      if (Date.now() - lastList >= 1500) {
        const list = await props.request("list", {}) as { sessions: Session[] };
        if (closed || generation !== epoch) return;
        lastList = Date.now();
        setSessions((old) =>
          list.sessions.map((next) =>
            old.find((previous) =>
              previous.session === next.session &&
              previous.profile === next.profile &&
              previous.done === next.done && previous.exitCode === next.exitCode
            ) ?? next
          )
        );
        for (const [id, view] of views) {
          if (!list.sessions.some((s) => s.session === id)) {
            dispose(view);
            views.delete(id);
          }
        }
        if (!list.sessions.some((s) => s.session === selected())) {
          choose(list.sessions[0]?.session ?? "");
        }
        if (!list.sessions.length && !autoStarted) await create();
      }
      const id = selected();
      if (!active() || !id || generation !== epoch) return;
      showSelected();
      const view = views.get(id)!;
      if (view.ended) {
        delay = 500;
        return;
      }
      const result = await props.request("read", {
        session: id,
        cursor: view.cursor,
      }) as {
        text: string;
        cursor: number;
        dropped: boolean;
        pending?: boolean;
        done: boolean;
        exitCode: number | null;
      };
      if (closed || view.disposed || generation !== epoch) return;
      if (result.dropped) {
        view.terminal.reset();
        view.terminal.write("\r\n[Earlier output discarded]\r\n");
      }
      if (result.text) {
        await new Promise<void>((resolve) => {
          view.acknowledge = resolve;
          view.terminal.write(result.text, () => {
            view.acknowledge = undefined;
            resolve();
          });
        });
      }
      if (view.disposed) return;
      view.cursor = result.cursor;
      if (result.done && !result.pending) {
        view.ended = true;
        view.terminal.options.disableStdin = true;
        view.terminal.write(
          `\r\n[Process exited${
            result.exitCode === null ? "" : ` with code ${result.exitCode}`
          }]\r\n`,
        );
      }
      setError("");
      delay = result.pending ? 0 : result.text ? 16 : 100;
    } catch (e) {
      if (!closed && generation === epoch) setError(String(e));
      delay = 1000;
    } finally {
      reading = false;
      if (active()) timer = setTimeout(poll, delay);
    }
  }
  onMount(() => {
    setReady(true);
    const observer = new ResizeObserver(() => {
      const view = views.get(selected());
      if (view) resize(selected(), view);
    });
    observer.observe(surface);
    const themes = new MutationObserver(() => {
      for (const view of views.values()) theme(view);
      showSelected();
    });
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "data-theme"],
    });
    onCleanup(() => {
      observer.disconnect();
      themes.disconnect();
    });
  });
  createEffect(() => {
    void props.workspaceId;
    untrack(() => {
      epoch++;
      autoStarted = false;
      lastList = 0;
      for (const view of views.values()) dispose(view);
      views.clear();
      input.length = 0;
      setSessions([]);
      setSelected("");
      wake();
    });
  });
  createEffect(() => {
    if (!ready()) return;
    const visible = props.active && props.connected;
    void selected();
    queueMicrotask(() => {
      showSelected();
      if (visible) wake();
      else clearTimeout(timer);
    });
  });
  createEffect(() => {
    if (!ready() || !active()) return;
    const action = props.action;
    if (!action || action.id <= lastAction) return;
    lastAction = action.id;
    if (action.create) void create();
    else {queueMicrotask(() => {
        showSelected(true);
        wake();
      });}
  });
  onCleanup(() => {
    closed = true;
    clearTimeout(timer);
    input.length = 0;
    for (const view of views.values()) dispose(view);
    views.clear();
  });
  return (
    <div class="terminal-container">
      <div class="terminal-picker">
        <div
          class="terminal-sessions"
          role="group"
          aria-label="Terminal sessions"
        >
          <For each={sessions()}>
            {(session, index) => (
              <button
                class="terminal-session"
                aria-pressed={selected() === session.session}
                onClick={() => choose(session.session)}
              >
                {session.profile} {index() + 1}
                {session.done ? " · exited" : ""}
              </button>
            )}
          </For>
        </div>
        <IconButton
          name="plus"
          label="New terminal"
          disabled={creating() || !props.connected}
          onClick={() => void create()}
        />
        <IconButton
          name="close"
          label="Close terminal session"
          disabled={!selected() || !props.connected}
          onClick={() => void closeSelected()}
        />
      </div>
      <Show when={error() || !props.connected}>
        <div class="terminal-error" role="status">
          {props.connected ? error() : "Desktop disconnected. Reconnecting…"}
        </div>
      </Show>
      <Show when={!sessions().length && !error()}>
        <div class="terminal-empty">
          {creating()
            ? "Starting shell…"
            : "Open a terminal with + to start a shell."}
        </div>
      </Show>
      <div class="terminal-surface" ref={surface} />
    </div>
  );
}
