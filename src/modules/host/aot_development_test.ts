import {
  deepStrictEqual as eq,
  notEqual,
  strictEqual,
} from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
} from "./development.ts";
import { ModuleHost } from "./host.ts";
import "./development-source_test.ts";
import "./development-lifecycle_test.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const executable = join(
  root,
  "native",
  "target",
  "release",
  `maghemite-wasm-host${Deno.build.os === "windows" ? ".exe" : ""}`,
);

async function sha256(path: string): Promise<string> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", await Deno.readFile(path)),
  ).toHex();
}

async function purePackage(directory: string): Promise<void> {
  await Deno.mkdir(join(directory, "assets"), { recursive: true });
  await Deno.writeTextFile(
    join(directory, "maghemite.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.development",
      version: "1.0.0",
      sdkVersion: "0.1.0",
      runtime: "deno",
      entry: "main.ts",
      capabilities: [],
      contributions: {
        commands: [{
          id: "test.development.run",
          title: "Development",
        }],
      },
    }),
  );
  await Deno.writeTextFile(
    join(directory, "main.ts"),
    'export default {commands:{"test.development.run":()=>1}};',
  );
  await Deno.writeTextFile(join(directory, "assets", "value.txt"), "one");
}

async function componentPackage(directory: string): Promise<void> {
  const source = join(root, "modules-sdk", "examples", "rust");
  const manifest = JSON.parse(
    await Deno.readTextFile(join(source, "maghemite.module.json")),
  );
  await Deno.mkdir(join(directory, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(directory, "maghemite.module.json"),
    JSON.stringify({ ...manifest, entry: "dist/module.wasm" }),
  );
  await Deno.copyFile(
    join(source, manifest.entry),
    join(directory, "dist", "module.wasm"),
  );
}

async function toolPackage(directory: string, tool: string): Promise<void> {
  const path = join(directory, "dist", "tool.wasm");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.mkdir(join(directory, "assets"), { recursive: true });
  await Deno.copyFile(tool, path);
  await Deno.writeTextFile(
    join(directory, "main.ts"),
    'export default {commands:{"test.tools.run":()=>null}};',
  );
  await Deno.writeTextFile(join(directory, "assets", "value.txt"), "one");
  await Deno.writeTextFile(
    join(directory, "maghemite.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.tools",
      version: "1.0.0",
      sdkVersion: "0.1.0",
      runtime: "deno",
      entry: "main.ts",
      capabilities: ["wasm.execute"],
      wasmTools: [{
        id: "engine",
        path: "dist/tool.wasm",
        sha256: await sha256(path),
        abi: "wasi-preview1",
        args: [],
        assets: "assets",
      }],
      contributions: {
        commands: [{ id: "test.tools.run", title: "Tools" }],
      },
    }),
  );
}

async function close(
  handles: readonly (PreparedRegistrationHandle | undefined)[],
): Promise<void> {
  for (const handle of handles.toReversed()) await handle?.close();
}

Deno.test("developer index reuses only an unchanged complete copied package", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-index-",
  });
  const source = join(base, "source");
  const storage = join(base, "private");
  const handles: PreparedRegistrationHandle[] = [];
  try {
    await purePackage(source);
    const first = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(first);
    await first.close();
    const second = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(second);
    strictEqual(second.reused, true);
    strictEqual(second.prepared.slot, first.prepared.slot);
    await second.close();

    await Deno.writeTextFile(
      join(source, "main.ts"),
      'export default {commands:{"test.development.run":()=>2}};',
    );
    const codeChanged = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(codeChanged);
    strictEqual(codeChanged.reused, false);
    notEqual(codeChanged.prepared.slot, first.prepared.slot);
    await codeChanged.close();

    await Deno.writeTextFile(join(source, "assets", "value.txt"), "two");
    const assetChanged = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(assetChanged);
    strictEqual(assetChanged.reused, false);
    notEqual(assetChanged.prepared.slot, codeChanged.prepared.slot);
  } finally {
    await close(handles);
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("prepared component ignores later source mutation and changed bytes get a fresh generation", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-component-",
  });
  const source = join(base, "source");
  const storage = join(base, "private");
  let first: PreparedRegistrationHandle | undefined;
  let changed: PreparedRegistrationHandle | undefined;
  const host = new ModuleHost({ wasmExecutable: executable });
  try {
    await componentPackage(source);
    first = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    await Deno.copyFile(
      join(root, "modules-sdk", "examples", "c", "dist", "module.wasm"),
      join(source, "dist", "module.wasm"),
    );
    await host.registerPrepared(first, ["log", "tasks.progress"]);
    eq(
      await host.execute("example.rust.count-words", "one two"),
      { words: 2 },
    );
    await host.close();
    await first.close();

    changed = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    strictEqual(changed.reused, false);
    notEqual(changed.prepared.slot, first.prepared.slot);
    notEqual(changed.prepared.artifactSetId, first.prepared.artifactSetId);
  } finally {
    await host.close();
    await close([first, changed]);
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("same-version tool, Deno code and assets select immutable snapshots", async () => {
  const base = await Deno.makeTempDir({
    prefix: "maghemite-development-tools-",
  });
  const source = join(base, "source");
  const storage = join(base, "private");
  const handles: PreparedRegistrationHandle[] = [];
  try {
    await toolPackage(
      source,
      join(root, "modules", "javascript", "dist", "oxc.wasm"),
    );
    const first = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(first);
    await first.close();
    const reused = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(reused);
    strictEqual(reused.reused, true);
    await reused.close();

    await Deno.copyFile(
      join(root, "build", "modules", "cpp", "dist", "clangd.wasm"),
      join(source, "dist", "tool.wasm"),
    );
    const manifestPath = join(source, "maghemite.module.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.wasmTools[0].sha256 = await sha256(
      join(source, "dist", "tool.wasm"),
    );
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
    const changed = await prepareRegistration(source, {
      executable,
      storageRoot: storage,
    });
    handles.push(changed);
    strictEqual(changed.reused, false);
    notEqual(changed.prepared.slot, first.prepared.slot);
    notEqual(changed.prepared.artifactSetId, first.prepared.artifactSetId);
  } finally {
    await close(handles);
    await Deno.remove(base, { recursive: true });
  }
});

