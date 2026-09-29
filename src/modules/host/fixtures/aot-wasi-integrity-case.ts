import { equal, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { AotError, type AotErrorCode } from "../../../shared/module_aot.ts";
import { canonicalDescriptor } from "../aot-schema.ts";
import { preparedToolReadiness } from "../prepared-readiness.ts";
import type { WasiEnvironment } from "./aot-wasi-support.ts";

function aotCode(code: AotErrorCode) {
  return (error: unknown): boolean => {
    ok(error instanceof AotError);
    equal(error.code, code);
    return true;
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return Object.fromEntries(Object.entries(value));
}

export async function verifyWasiIntegrity(
  test: Deno.TestContext,
  environment: WasiEnvironment,
): Promise<void> {
  const granted = new Set(["wasm.execute"]);
  const request = (
    owner: string,
    prepared = environment.readiness,
  ) =>
    environment.tools.request({
      pkg: environment.pkg,
      owner,
      granted,
      prepared,
      signal: new AbortController().signal,
    }, { method: "wasm.start", parameters: { tool: "oxc" } });

  await test.step("swapped binding stale bytes and executable mismatch fail closed", async () => {
    const pin = await environment.registration.store.pin(
      environment.registration.prepared,
    );
    ok(pin.directory && pin.descriptor);
    const descriptorPath = join(pin.directory, "descriptor.json");
    const descriptorBytes = await Deno.readFile(descriptorPath);
    const targets = pin.descriptor.targets.filter((target) =>
      target.kind === "wasi-tool"
    );
    equal(targets.length, 2);
    const swappedTools = targets.map((target, index) => {
      const other = targets[index === 0 ? 1 : 0];
      ok(other);
      return {
        ...other,
        toolId: target.toolId,
        artifact: { ...other.artifact, file: target.artifact.file },
      };
    });
    let toolIndex = 0;
    const swapped = {
      ...pin.descriptor,
      targets: pin.descriptor.targets.map((target) =>
        target.kind === "wasi-tool"
          ? swappedTools[toolIndex++] ?? target
          : target
      ),
    };
    pin.release();
    await Deno.chmod(descriptorPath, 0o600);
    try {
      await Deno.writeFile(descriptorPath, canonicalDescriptor(swapped));
      await rejects(request("swapped"), aotCode("integrity"));
    } finally {
      await Deno.writeFile(descriptorPath, descriptorBytes);
      await Deno.chmod(descriptorPath, 0o400);
      await environment.tools.release("swapped");
    }

    const ready = await environment.registration.store.pin(
      environment.registration.prepared,
    );
    ok(ready.directory && ready.descriptor);
    const artifact = ready.descriptor.targets.find((target) =>
      target.kind === "wasi-tool" && target.toolId === "oxc"
    );
    ok(artifact);
    const artifactPath = join(ready.directory, artifact.artifact.file);
    const artifactBytes = await Deno.readFile(artifactPath);
    ready.release();
    artifactBytes[artifactBytes.length - 1] ^= 1;
    await Deno.chmod(artifactPath, 0o600);
    try {
      await Deno.writeFile(artifactPath, artifactBytes);
      await rejects(request("stale-bytes"), aotCode("integrity"));
    } finally {
      artifactBytes[artifactBytes.length - 1] ^= 1;
      await Deno.writeFile(artifactPath, artifactBytes);
      await Deno.chmod(artifactPath, 0o400);
      await environment.tools.release("stale-bytes");
    }

    const wrongExecutable = `${environment.base}/wrong-native-host`;
    await Deno.writeTextFile(wrongExecutable, "not the prepared producer");
    const mismatch = preparedToolReadiness(
      environment.registration,
      wrongExecutable,
      () => true,
    );
    ok(mismatch);
    await rejects(
      request("executable-mismatch", mismatch),
      aotCode("integrity"),
    );
    await environment.tools.release("executable-mismatch");
  });

  await test.step("missing artifact is unavailable and reclaim waits for exit", async () => {
    const pin = await environment.registration.store.pin(
      environment.registration.prepared,
    );
    ok(pin.directory && pin.descriptor);
    const target = pin.descriptor.targets.find((item) =>
      item.kind === "wasi-tool" && item.toolId === "oxc"
    );
    ok(target);
    const artifactPath = join(pin.directory, target.artifact.file);
    pin.release();
    const missingPath = `${artifactPath}.missing`;
    await Deno.rename(artifactPath, missingPath);
    try {
      await rejects(request("missing"), aotCode("unavailable"));
    } finally {
      await Deno.rename(missingPath, artifactPath);
      await environment.tools.release("missing");
    }

    const id = object(await request("exit-bound")).id;
    ok(typeof id === "string");
    await rejects(environment.reclaim(), /active pins/);
    await environment.request(
      "exit-bound",
      granted,
      "wasm.stop",
      { id },
    );
    await environment.reclaim();
  });
}
