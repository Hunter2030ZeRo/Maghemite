import { equal, ok, rejects } from "node:assert/strict";
import { wasiEnvironment } from "./aot-wasi-support.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return Object.fromEntries(Object.entries(value));
}

function append(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

async function lspResponse(
  read: () => Promise<unknown>,
  expectedId: number,
): Promise<Record<string, unknown>> {
  const delimiter = [13, 10, 13, 10] as const;
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  while (true) {
    const result = object(await read());
    ok(result.eof === false && typeof result.data === "string");
    buffered = append(buffered, Uint8Array.fromBase64(result.data));
    while (true) {
      const headerEnd = buffered.findIndex((_, index) =>
        delimiter.every((byte, offset) => buffered[index + offset] === byte)
      );
      if (headerEnd < 0) break;
      const header = new TextDecoder().decode(buffered.subarray(0, headerEnd));
      const match = /^Content-Length:\s*(\d+)$/mi.exec(header);
      ok(match);
      const length = Number(match[1]);
      const bodyStart = headerEnd + delimiter.length;
      if (buffered.length < bodyStart + length) break;
      const message = object(
        JSON.parse(
          new TextDecoder().decode(
            buffered.subarray(bodyStart, bodyStart + length),
          ),
        ),
      );
      buffered = buffered.subarray(bodyStart + length);
      if (message.id === expectedId) return message;
    }
  }
}

export async function verifyWasiIo(): Promise<void> {
  await using environment = await wasiEnvironment();
  const granted = new Set(["wasm.execute"]);
  const call = (
    method: string,
    parameters: Record<string, string>,
    owner = "owner",
    signal = new AbortController().signal,
  ) => environment.request(owner, granted, method, parameters, signal);
  let compilerPermitObserved = false;
  const observe = () => {
    compilerPermitObserved ||= environment.executionResources.inspect()
      .processes.some((process) => process.compilerPermit);
  };
  environment.executionResources.addEventListener("change", observe);
  try {
    await rejects(
      environment.request("owner", new Set(), "wasm.start", { tool: "oxc" }),
      /denied/,
    );
    await rejects(
      () => call("wasm.start", { tool: "host-node" }),
      /unavailable/,
    );
    const id = object(await call("wasm.start", { tool: "oxc" })).id;
    const cooperative = object(
      await call("wasm.start", { tool: "typescript" }),
    ).id;
    ok(typeof id === "string" && typeof cooperative === "string");
    await rejects(
      environment.registration.store.reclaim(
        environment.registration.prepared,
      ),
      /active pins/,
    );
    await rejects(() => call("wasm.read", { id }, "other"), /unavailable/);
    await rejects(() => call("wasm.start", { tool: "oxc" }), /already running/);
    await rejects(() => call("wasm.write", { id, data: "A".repeat(32772) }));
    const request = JSON.stringify({
      method: "formatting",
      path: "test.ts",
      text: "const x={a:1};\n",
    }) + "\n";
    await call("wasm.write", { id, data: btoa(request) });
    let line = "";
    while (!line.includes("\n")) {
      const result = object(await call("wasm.read", { id }));
      ok(result.eof === false && typeof result.data === "string");
      line += atob(result.data);
    }
    ok(object(JSON.parse(line)).result);

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: null,
        capabilities: {},
        initializationOptions: {},
      },
    });
    const initializeBytes = new TextEncoder().encode(initialize);
    await call("wasm.write", {
      id: cooperative,
      data: new TextEncoder().encode(
        `Content-Length: ${initializeBytes.length}\r\n\r\n${initialize}`,
      ).toBase64(),
    });
    const initialized = await lspResponse(
      () => call("wasm.read", { id: cooperative }),
      1,
    );
    ok(object(initialized.result).capabilities);

    const cancel = new AbortController();
    const pending = call("wasm.read", { id }, "owner", cancel.signal);
    await rejects(() => call("wasm.read", { id }), /busy/);
    cancel.abort();
    await rejects(() => pending);
    await call("wasm.stop", { id });
    await call("wasm.stop", { id: cooperative });
    await rejects(() => call("wasm.read", { id }), /unavailable/);
  } finally {
    environment.executionResources.removeEventListener("change", observe);
    await environment.tools.release("owner");
    await environment.tools.release("other");
  }
  equal(compilerPermitObserved, false);
  equal(environment.executionResources.inspect().processes.length, 0);
}
