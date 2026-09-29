import type { AppMethod } from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import type { InstallationState } from "../../../src/shared/module_installations.ts";
import { INSTALLATION_TRANSFER } from "../../../src/shared/installation_transport.ts";

export interface ModuleCommand {
  id: string;
  title: string;
  moduleId: string;
}
/** The host proved this request was rejected before durable acceptance. */
export class InstallationNotAcceptedError extends Error {}
/** HTTP is bootstrap only; one authenticated socket owns commands and API calls. */
export function connectModules(options: {
  invoke(
    method: AppMethod,
    parameters: Json,
    moduleId: string,
    owner?: string,
  ): Json;
  internal?(
    method: string,
    parameters: Record<string, Json>,
    owner: string,
  ): Json | Promise<Json>;
  release?(owner: string): void;
  reset?(): void;
  catalog(commands: ModuleCommand[]): void;
  installations?(state: InstallationState): void;
  exposed?(moduleId: string): void;
  status(connected: boolean): void;
  ready?(): Promise<void>;
  notify(message: string): void;
  scheduleTimeout?(expire: () => void, milliseconds: number): () => void;
}) {
  const scheduleTimeout = options.scheduleTimeout ?? ((expire, milliseconds) => {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  });
  const stop = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let ready = false;
  let socket: WebSocket | undefined, sequence = 0, lastRequest = 0;
  const pending = new Map<
    number,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  const transfers = new Map<number, { transfer: number; text: string }>();
  const fail = () => {
    ready = false;
    const old = socket;
    socket = undefined;
    old?.close();
    options.reset?.();
    options.status(false);
    options.catalog([]);
    for (const request of pending.values()) {
      request.reject(new Error("Module host disconnected"));
    }
    pending.clear();
    transfers.clear();
    if (!stop.signal.aborted && retry === undefined) {
      retry = setTimeout(() => {
        retry = undefined;
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    }
  };
  async function connect() {
    try {
      const response = await fetch("/api/workbench/session", {
        headers: { "X-Maghemite-Client": "1" },
        signal: stop.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Module host unavailable");
      const { token } = await response.json();
      if (stop.signal.aborted) return;
      const url = new URL("/api/workbench/connect", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const current = socket = new WebSocket(url, ["maghemite-v1", token]);
      lastRequest = 0;
      current.onopen = () => {
        retryDelay = 1000;
        void (options.ready?.() ?? Promise.resolve()).then(() => {
          if (socket !== current) return;
          ready = true;
          options.catalog(catalog);
          options.status(true);
        }, (e) => {
          if (socket !== current) return;
          options.notify(String(e));
          fail();
        });
      };
      current.onclose = () => {
        if (socket === current) fail();
      };
      current.onerror = () => {
        if (socket === current) fail();
      };
      let catalog: ModuleCommand[] = [];
      socket.onmessage = async (event) => {
        if (socket !== current) return;
        try {
          if (
            typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).length >= 65536
          ) throw new Error("Invalid host frame");
          let msg = JSON.parse(event.data);
          if (msg.type === "installationChunk") {
            if (
              !Number.isSafeInteger(msg.requestId) || msg.requestId < 0 ||
              !Number.isSafeInteger(msg.transfer) || msg.transfer < 1 ||
              !Number.isSafeInteger(msg.offset) || msg.offset < 0 ||
              typeof msg.part !== "string" || !msg.part.length ||
              msg.part.length > INSTALLATION_TRANSFER.characters ||
              typeof msg.done !== "boolean"
            ) throw new Error("Invalid installation chunk");
            if (msg.requestId !== 0 && !pending.has(msg.requestId)) return;
            if (msg.offset === 0) {
              if (!transfers.has(msg.requestId) &&
                  transfers.size >= INSTALLATION_TRANSFER.pending) {
                throw new Error("Installation transfer queue full");
              }
              transfers.set(msg.requestId, { transfer: msg.transfer, text: "" });
            }
            const transfer = transfers.get(msg.requestId);
            if (!transfer || transfer.transfer !== msg.transfer ||
                transfer.text.length !== msg.offset) {
              throw new Error("Invalid installation chunk order");
            }
            transfer.text += msg.part;
            if (new TextEncoder().encode(transfer.text).length > INSTALLATION_TRANSFER.bytes) {
              throw new Error("Installation message too large");
            }
            if (!msg.done) {
              current.send(JSON.stringify({
                type: "nextInstallationChunk", id: ++sequence,
                requestId: msg.requestId, transfer: msg.transfer,
                offset: transfer.text.length,
              }));
              return;
            }
            transfers.delete(msg.requestId);
            const complete = JSON.parse(transfer.text);
            if (msg.requestId === 0 ? complete.type !== "installations"
              : complete.type !== "executed" || complete.id !== msg.requestId) {
              throw new Error("Installation message ownership mismatch");
            }
            msg = complete;
          }
          if (msg.type === "catalog") {
            if (msg.offset === 0) catalog = [];
            catalog.push(...msg.commands);
            if (msg.done && ready) options.catalog(catalog);
          } else if (msg.type === "installations") {
            transfers.delete(0);
            options.installations?.(msg.state);
          } else if (msg.type === "modules-exposed") {
            options.exposed?.(msg.moduleId);
          } else if (msg.type === "request") {
            if (!Number.isSafeInteger(msg.id) || msg.id <= lastRequest) {
              throw new Error("Invalid host request");
            }
            lastRequest = msg.id;
            let reply;
            try {
              if (Date.now() > msg.expires) {
                throw new Error("Application request expired");
              }
              const value = msg.internal
                ? await options.internal?.(
                  msg.method,
                  msg.parameters,
                  msg.owner,
                ) ??
                  null
                : options.invoke(
                  msg.method,
                  msg.parameters,
                  msg.moduleId,
                  msg.owner,
                );
              reply = { type: "result", id: msg.id, ok: true, value };
              if (
                new TextEncoder().encode(JSON.stringify(reply)).length >= 64000
              ) throw new Error("Application result exceeds transport limit");
            } catch (error) {
              reply = {
                type: "result",
                id: msg.id,
                ok: false,
                error: String(error).slice(0, 2048),
              };
            }
            if (socket === current && current.readyState === WebSocket.OPEN) {
              current.send(JSON.stringify(reply));
            }
          } else if (msg.type === "release") options.release?.(msg.owner);
          else if (msg.type === "executed") {
            const request = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.ok) request?.resolve(msg.value);
            else request?.reject(msg.installationAccepted === false
              ? new InstallationNotAcceptedError(msg.error)
              : new Error(msg.error));
          } else throw new Error("Unknown host message");
        } catch {
          socket?.close(1008);
          fail();
        }
      };
    } catch {
      if (!stop.signal.aborted && retryDelay === 1000) {
        options.notify(
          "Desktop unavailable. Reconnecting; your drafts are retained.",
        );
      }
      fail();
    }
  }
  void connect();
  async function terminal(
    action: string,
    parameters: Json = {},
    type = "terminal",
    signal?: AbortSignal,
  ): Promise<Json> {
    signal?.throwIfAborted();
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Module host disconnected");
    }
    const cancellation = type === "workbench" &&
      (action === "languages.cancel" || action === "modules.cancelInstallation");
    if (pending.size >= (cancellation ? 24 : 16)) {
      throw new Error("Workbench queue full");
    }
    const current = socket;
    const id = ++sequence;
    const text = JSON.stringify({ type, id, action, parameters });
    if (new TextEncoder().encode(text).length >= 65536) {
      throw new Error("Workbench frame too large");
    }
    let clearTimer: (() => void) | undefined;
    const cancel = () => {
      if (socket === current && current.readyState === WebSocket.OPEN) {
        // A control frame consumes no request slot. It owns only this RPC,
        // never a durably accepted application operation.
        current.send(JSON.stringify({
          type: "cancelRequest", id: ++sequence, requestId: id,
        }));
      }
    };
    const abort = () => {
      cancel();
      pending.get(id)?.reject(signal?.reason);
    };
    try {
      return await new Promise<Json>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        clearTimer = scheduleTimeout(
          () => {
            cancel();
            reject(new Error("Desktop request timed out"));
          },
          action === "workspace.browse"
            ? 300000
            : type === "saveDocument" || type === "workbench"
            ? 60000
            : 4000,
        );
        signal?.addEventListener("abort", abort, { once: true });
        current.send(text);
      });
    } finally {
      clearTimer?.();
      signal?.removeEventListener("abort", abort);
      pending.delete(id);
      transfers.delete(id);
    }
  }
  return {
    terminal,
    request: (method: string, parameters: Json = {}, signal?: AbortSignal) =>
      terminal(method, parameters, "workbench", signal),
    save: (id: string, version: string) =>
      terminal("save", { id, version }, "saveDocument"),
    event(topic: string, data: Json, owner?: string) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "event", id: ++sequence, topic, data, owner }),
        );
      }
    },
    async execute(command: string, input: Json = null): Promise<Json> {
      if (!ready || !socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Module host disconnected");
      }
      if (pending.size >= 8) throw new Error("Too many module commands");
      const id = ++sequence;
      let resolve!: (value: Json) => void, reject!: (error: Error) => void;
      const promise = new Promise<Json>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const done = { promise, resolve, reject };
      pending.set(id, done);
      try {
        socket.send(JSON.stringify({ type: "execute", id, command, input }));
        return await done.promise;
      } finally {
        pending.delete(id);
      }
    },
    close() {
      stop.abort();
      clearTimeout(retry);
      socket?.close();
      fail();
    },
  };
}
