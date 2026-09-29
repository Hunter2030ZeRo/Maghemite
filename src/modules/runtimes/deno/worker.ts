import type {
  Json,
  ModuleContext,
  ModuleDefinition,
} from "../../../../modules-sdk/js/mod.ts";
import { frame, frames, jsonCopy } from "../protocol.ts";
import { fileUrl } from "../../paths.ts";
import { createAppAPI } from "../../../../modules-sdk/js/app.ts";

// Reserve stdout for IPC; ordinary module diagnostics go to stderr.
for (const method of ["log", "info", "debug", "warn", "error"] as const) {
  console[method] = (...values: unknown[]) => {
    const text = values.map((value) =>
      typeof value === "string"
        ? value
        : Deno.inspect(value, { depth: 3, colors: false })
    ).join(" ").slice(0, 4096);
    Deno.stderr.writeSync(new TextEncoder().encode(text + "\n"));
  };
}

const writer = Deno.stdout.writable.getWriter();
let writes = Promise.resolve();
function send(value: unknown): Promise<void> {
  const bytes = frame(value);
  const next = writes.then(() => writer.write(bytes));
  writes = next.catch(() => {});
  return next;
}
const pending = new Map<
  number,
  { resolve(value: Json): void; reject(error: Error): void }
>();
let sequence = 0;
let current = 0;
let running = false;
let definition: ModuleDefinition | undefined;
const abort = new AbortController();
const cleanup: (() => void | Promise<void>)[] = [];

async function event(method: string, payload: unknown): Promise<Json> {
  if (!running || pending.size >= 8) {
    throw new Error("No active call or too many unacknowledged events");
  }
  const id = ++sequence;
  const reply = new Promise<Json>((resolve, reject) =>
    pending.set(id, { resolve, reject })
  );
  try {
    await send({ type: "event", id, call: current, method, payload });
    return await reply;
  } finally {
    pending.delete(id);
  }
}
const context: ModuleContext = {
  app: createAppAPI((method, parameters) =>
    event("app.request", { method, parameters })
  ),
  signal: abort.signal,
  log: async (message) => {
    await event("log", message);
  },
  reportProgress: async (value) => {
    await event("tasks.progress", value);
  },
  delay: async (milliseconds) => {
    await event("tasks.delay", milliseconds);
  },
  runWorker: (command, input) =>
    event("tasks.run-worker", { command, input: jsonCopy(input) }),
  onDispose(callback) {
    if (typeof callback !== "function") {
      throw new Error("Expected cleanup function");
    }
    cleanup.push(callback);
  },
};

async function dispose(): Promise<void> {
  abort.abort();
  let failure: unknown;
  try {
    await definition?.deactivate?.(context);
  } catch (error) {
    failure = error;
  }
  for (const callback of cleanup.splice(0).reverse()) {
    try {
      await callback();
    } catch (error) {
      failure ??= error;
    }
  }
  definition = undefined;
  if (failure) throw failure;
}

async function handle(request: Record<string, unknown>): Promise<void> {
  const id = request.id;
  if (!Number.isSafeInteger(id) || running) {
    throw new Error("Invalid or overlapping lifecycle request");
  }
  current = id as number;
  running = true;
  let failed = false;
  try {
    let value: unknown = null;
    if (request.method === "activate" && !definition) {
      const path = Deno.args[0];
      const entry = fileUrl(path);
      const exported = (await import(entry.href)).default;
      if (
        !exported || typeof exported.commands !== "object" ||
        Object.values(exported.commands).some((handler) =>
          typeof handler !== "function"
        )
      ) throw new Error("Invalid module definition");
      definition = exported;
      await definition!.activate?.(context);
      value = Object.keys(definition!.commands);
    } else if (
      request.method === "execute" && definition &&
      typeof request.command === "string"
    ) {
      const handler = Object.hasOwn(definition.commands, request.command) &&
        definition.commands[request.command];
      if (!handler) throw new Error("Unknown command");
      value = await handler(request.input as Json, context);
      // JSON serialization also rejects BigInt, cyclic values and undefined.
      value = jsonCopy(value);
    } else if (request.method === "deactivate" && definition) {
      await dispose();
    } else throw new Error("Invalid module lifecycle state");
    if (pending.size) {
      throw new Error(
        "Module returned with unacknowledged host calls; await SDK operations",
      );
    }
    // The parent may receive the bytes and submit its next request before the
    // stdout write promise resolves. Publish the idle state before the reply.
    running = false;
    await send({ type: "response", id, ok: true, value });
  } catch (error) {
    failed = true;
    await send({
      type: "response",
      id,
      ok: false,
      error: String(error).slice(0, 4096),
    });
  } finally {
    // A newer call may already be running while this response finishes flushing.
    if (current === id) running = false;
    if (request.method === "deactivate" || failed) {
      if (failed) {
        try {
          await dispose();
        } catch { /* Parent terminates on failure. */ }
      }
      await writes;
      Deno.exit(failed ? 1 : 0);
    }
  }
}

// Keep the reader running while guest code awaits an SDK acknowledgement.
for await (const message of frames(Deno.stdin.readable)) {
  if (message.type === "ack") {
    const wait = pending.get(message.id as number);
    if (!wait) throw new Error("Unknown host acknowledgement");
    if (message.ok === true) wait.resolve((message.value ?? null) as Json);
    else wait.reject(new Error(String(message.error)));
  } else if (message.type === "request") {
    void handle(message).catch(async (error) => {
      await send({
        type: "response",
        id: message.id,
        ok: false,
        error: String(error),
      });
      Deno.exit(1);
    });
  } else throw new Error("Unknown host message");
}
abort.abort();
for (const reply of pending.values()) {
  reply.reject(new Error("Module host disconnected"));
}
Deno.exit(0);
