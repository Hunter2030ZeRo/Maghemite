import { equal, rejects, throws } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ModuleHost } from "./host.ts";
import { loadPackage, resolveWasmTool, validateManifest } from "./manifest.ts";
import { verifyWasiAdmission } from "./fixtures/aot-wasi-admission-case.ts";
import { verifyWasiIntegrity } from "./fixtures/aot-wasi-integrity-case.ts";
import { verifyWasiIo } from "./fixtures/aot-wasi-io-case.ts";
import { wasiEnvironment } from "./fixtures/aot-wasi-support.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return Object.fromEntries(Object.entries(value));
}

Deno.test("packaged WASI: declaration, checksum and package boundary validation", async () => {
  const base = JSON.parse(
    await Deno.readTextFile(root + "modules/javascript/maghemite.module.json"),
  );
  for (
    const patch of [
      { path: "../engine.wasm" },
      { abi: "native" },
      { sha256: "bad" },
      { stdin: "unknown" },
      { args: ["x\0y"] },
      { executable: "node" },
    ]
  ) {
    const value = structuredClone(base);
    Object.assign(value.wasmTools[0], patch);
    throws(() => validateManifest(value));
  }
  const directory = await Deno.makeTempDir({ prefix: "wasm-package-test-" });
  try {
    base.entry = "main.ts";
    base.wasmTools = [{
      id: "bad",
      path: "tool.wasm",
      abi: "wasi-preview1",
      args: [],
      sha256: "0".repeat(64),
    }];
    await Deno.writeTextFile(
      `${directory}/maghemite.module.json`,
      JSON.stringify(base),
    );
    await Deno.writeTextFile(`${directory}/main.ts`, "export default {};");
    await Deno.writeFile(
      `${directory}/tool.wasm`,
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    await rejects(() => loadPackage(directory), /checksum/);
    await Deno.remove(`${directory}/tool.wasm`);
    await Deno.symlink(
      `${root}modules/javascript/dist/oxc.wasm`,
      `${directory}/tool.wasm`,
    );
    await rejects(() => loadPackage(directory), /escapes/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("legacy WASI source mode is rejected without compilation", async () => {
  const result = await new Deno.Command(
    `${root}native/target/release/maghemite-wasm-host`,
    {
      args: [
        "--wasi-tool",
        `${root}modules/javascript/dist/oxc.wasm`,
        "",
        "",
        "blocking",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: { MAGHEMITE_COMPILE_NOTIFY: "1" },
    },
  ).output();
  equal(result.code, 1);
  equal(
    new TextDecoder().decode(result.stderr).includes(
      "\x1eMAGHEMITE_COMPILED_V1\n",
    ),
    false,
  );
});

Deno.test(
  "packaged WASI: explicit grants, owner isolation, bounded streams and cancellation",
  verifyWasiIo,
);

Deno.test("prepared WASI: integrity cancellation admission and exit ownership fences", async (test) => {
  await using environment = await wasiEnvironment();
  await verifyWasiAdmission(test, environment);
  await verifyWasiIntegrity(test, environment);
});

Deno.test("SDK discovery advertises WASI only with permission and a configured host", async () => {
  const directory = await Deno.makeTempDir({ prefix: "wasi-sdk-discovery-" });
  await Deno.writeTextFile(
    `${directory}/maghemite.module.json`,
    JSON.stringify({
      schemaVersion: 1,
      id: "test.wasi",
      version: "0.1.0",
      sdkVersion: "0.1.0",
      runtime: "deno",
      entry: "main.ts",
      capabilities: ["wasm.execute"],
      contributions: {
        commands: [{ id: "test.wasi.describe", title: "Describe" }],
      },
    }),
  );
  await Deno.writeTextFile(
    `${directory}/main.ts`,
    'export default {commands:{"test.wasi.describe":(_,context)=>context.app.describe()}};',
  );
  try {
    for (
      const [configured, granted] of [[false, true], [true, false], [
        true,
        true,
      ]]
    ) {
      const host = new ModuleHost({
        wasmExecutable: configured
          ? `${root}native/target/release/maghemite-wasm-host`
          : undefined,
      });
      try {
        await host.register(directory, granted ? ["wasm.execute"] : []);
        equal(
          JSON.stringify(
            object(await host.execute("test.wasi.describe")).methods,
          ),
          JSON.stringify(
            configured && granted
              ? ["wasm.start", "wasm.write", "wasm.read", "wasm.stop"]
              : [],
          ),
        );
      } finally {
        await host.close();
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("packaged WASI: streaming verification covers chunk boundaries and rechecks every launch", async () => {
  const directory = await Deno.makeTempDir({ prefix: "wasi-hash-test-" });
  const path = `${directory}/tool.wasm`;
  const bytes = Uint8Array.from(
    { length: 2 * 1024 * 1024 + 3 },
    (_, index) => index % 251,
  );
  bytes.set([0, 97, 115, 109, 1, 0, 0, 0]);
  const digest = async () =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const tool = {
    id: "test",
    path: "tool.wasm",
    abi: "wasi-preview1" as const,
    args: [],
    sha256: await digest(),
  };
  try {
    await Deno.writeFile(path, bytes);
    equal((await resolveWasmTool(directory, tool)).path, path);
    bytes[1024 * 1024] ^= 1;
    await Deno.writeFile(path, bytes);
    await rejects(() => resolveWasmTool(directory, tool), /checksum/);
    bytes[4] = 2;
    tool.sha256 = await digest();
    await Deno.writeFile(path, bytes);
    await rejects(() => resolveWasmTool(directory, tool), /ABI/);
    await Deno.writeFile(path, bytes.subarray(0, 7));
    await rejects(() => resolveWasmTool(directory, tool), /size/);
    await Deno.truncate(path, 128 * 1024 * 1024 + 1);
    await rejects(() => resolveWasmTool(directory, tool), /size/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
