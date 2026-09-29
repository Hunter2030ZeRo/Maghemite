import { deepStrictEqual as eq, equal, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { WorkbenchLanguages } from "../../desktop/languages.ts";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
} from "./development.ts";
import { ModuleHost } from "./host.ts";
import { ResourceAdmission } from "./resources.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const executable = join(
  root,
  "native",
  "target",
  "release",
  `maghemite-wasm-host${Deno.build.os === "windows" ? ".exe" : ""}`,
);

function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return value;
}

Deno.test("native preparation shares one compiler slot; component and tool loads use none", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-resource-native-",
  });
  const resources = new ResourceAdmission({ coreRss: () => 64 * 1048576 });
  const host = new ModuleHost({ resources, wasmExecutable: executable });
  const bridge = new WorkbenchLanguages();
  const handles: PreparedRegistrationHandle[] = [];
  let peakCompilers = 0;
  const preparedModules = new Set<string>();
  let preparing = true;
  let executionCompilerObserved = false;
  resources.addEventListener("change", () => {
    const snapshot = resources.inspect();
    if (preparing) {
      peakCompilers = Math.max(peakCompilers, snapshot.compilation.active);
      for (const process of snapshot.processes) {
        if (process.phase === "preparing") {
          preparedModules.add(process.moduleId);
        }
      }
    } else if (snapshot.compilation.active > 0) {
      executionCompilerObserved = true;
    }
  });
  try {
    const results = await Promise.allSettled([
      prepareRegistration(join(root, "modules-sdk", "examples", "rust"), {
        executable,
        resources,
        storageRoot: join(base, "component"),
      }),
      prepareRegistration(join(root, "build", "modules", "javascript"), {
        executable,
        resources,
        storageRoot: join(base, "tools"),
      }),
    ].map(async (pending) => {
      const handle = await pending;
      handles.push(handle);
      return handle;
    }));
    // Await every sibling before cleanup, even if another preparation failed.
    const [componentResult, toolsResult] = results;
    if (componentResult.status === "rejected") throw componentResult.reason;
    if (toolsResult.status === "rejected") throw toolsResult.reason;
    const component = componentResult.value, tools = toolsResult.value;
    equal(peakCompilers, 1);
    eq([...preparedModules].toSorted(), [
      "example.rust",
      "maghemite.javascript",
    ]);
    equal(resources.inspect().compilation.active, 0);
    preparing = false;

    await host.registerPrepared(component, ["log", "tasks.progress"]);
    await host.registerPrepared(tools, ["documents.read", "wasm.execute"]);
    const [words, hover] = await Promise.all([
      host.execute("example.rust.count-words", "one two"),
      bridge.request(
        host,
        "qa.ts",
        { method: "hover", version: "1", offset: 6 },
        () => Promise.resolve("const answer: number = 1;\n"),
        AbortSignal.timeout(60_000),
      ),
    ]);
    eq(words, { words: 2 });
    ok(String(object(object(hover).result).text).includes("number"));
    equal(executionCompilerObserved, false);
    equal(resources.inspect().compilation.active, 0);
  } finally {
    bridge.clear();
    await host.close();
    for (const handle of handles.toReversed()) await handle.close();
    await Deno.remove(base, { recursive: true });
  }
  eq(resources.inspect().processes, []);
  equal(resources.inspect().reservedBytes, 0);
});

Deno.test("real native preparation failure returns its reservation and compiler slot", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-resource-failure-",
  });
  const source = join(base, "source");
  const resources = new ResourceAdmission({ coreRss: () => 0 });
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 1, 255]);
  try {
    await Deno.mkdir(source);
    await Deno.writeFile(join(source, "broken.wasm"), bytes);
    await Deno.writeTextFile(
      join(source, "main.ts"),
      'export default {commands:{"test.compile-failure.run":()=>null}};',
    );
    await Deno.writeTextFile(
      join(source, "maghemite.module.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "test.compile-failure",
        sdkVersion: "0.1.0",
        version: "0.1.0",
        runtime: "deno",
        entry: "main.ts",
        capabilities: ["wasm.execute"],
        wasmTools: [{
          id: "broken",
          path: "broken.wasm",
          abi: "wasi-preview1",
          args: [],
          sha256: new Uint8Array(
            await crypto.subtle.digest("SHA-256", bytes),
          ).toHex(),
        }],
        contributions: {
          commands: [{ id: "test.compile-failure.run", title: "Run" }],
        },
      }),
    );
    await rejects(
      prepareRegistration(source, {
        executable,
        resources,
        storageRoot: join(base, "private"),
      }),
      /Native preparation failed/,
    );
    equal(resources.inspect().reservedBytes, 0);
    equal(resources.inspect().compilation.active, 0);
    eq(resources.inspect().processes, []);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
