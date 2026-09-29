import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { AOT_LIMITS, type ArtifactDescriptor, type ArtifactTarget } from "../../shared/module_aot.ts";
import { artifactSetId, canonicalDescriptor, parseDescriptor } from "./aot-schema.ts";
import { fixtureProducer } from "./aot-test-fixtures.ts";

const golden: ArtifactDescriptor = {
  schemaVersion: 1, slot: "11111111-1111-4111-8111-111111111111",
  moduleId: "test.aot", moduleVersion: "1.0.0", manifestSha256: "a".repeat(64),
  targets: [{
    kind: "component-entry", toolId: null, sourcePath: "dist/module.wasm",
    sourceSize: 8, sourceSha256: "b".repeat(64), format: "component",
    abi: "component-async-v1", producer: fixtureProducer,
    artifact: { file: "component.cwasm", size: 16, sha256: "d".repeat(64) },
  }],
};

Deno.test("canonical descriptor matches cross-language golden bytes and hash", () => {
  // Given the machine-consumed wave-1 fixture, independent of encoder output.
  const expected = '{"manifestSha256":"' + "a".repeat(64) +
    '","moduleId":"test.aot","moduleVersion":"1.0.0","schemaVersion":1,"slot":"11111111-1111-4111-8111-111111111111","targets":[{"abi":"component-async-v1","artifact":{"file":"component.cwasm","sha256":"' +
    "d".repeat(64) + '","size":16},"format":"component","kind":"component-entry","producer":{"compilationFingerprint":"0123456789abcdef","cpuPolicy":"host-native","identity":"' +
    "c".repeat(64) + '","recipeVersion":1,"target":"x86_64-unknown-linux-gnu","wasmtimeVersion":"49.0.1"},"sourcePath":"dist/module.wasm","sourceSha256":"' +
    "b".repeat(64) + '","sourceSize":8,"toolId":null}]}';
  // When encoding.
  const bytes = canonicalDescriptor(golden);
  // Then exact wire bytes and their independently supplied digest match.
  equal(new TextDecoder().decode(bytes), expected);
  equal(artifactSetId(golden), "adf730ec565881caebc0162ad55c4d69e1f374f1142fbca78a641502adc02a5f");
});

Deno.test("canonical descriptor rejects malformed bindings and size boundaries", () => {
  // Given invalid machine values, not prose expectations.
  const target = golden.targets[0];
  if (!target) throw new Error("Missing golden target");
  const invalid = [
    { ...golden, schemaVersion: 2 }, { ...golden, extra: true },
    { ...golden, slot: "../escape" }, { ...golden, targets: Array(4).fill(target) },
    ...[
      { toolId: "forged" }, { sourcePath: "../module.wasm" },
      { sourcePath: "\ud800.wasm" }, { sourceSize: -1 },
      { sourceSize: Number.MAX_SAFE_INTEGER + 1 }, { sourceSize: 1.5 },
      { sourceSize: AOT_LIMITS.component + 1 },
      { format: "core-module" }, { abi: "wasi-p1-blocking-v1" },
      { producer: { ...fixtureProducer, identity: "C".repeat(64) } },
      { producer: { ...fixtureProducer, recipeVersion: 2 } },
      { artifact: { ...target.artifact, file: "../component.cwasm" } },
      { artifact: { ...target.artifact, size: AOT_LIMITS.object + 1 } },
    ].map((patch) => ({ ...golden, targets: [{ ...target, ...patch }] })),
    { ...golden, targets: [target, target] },
  ];
  // When parsing each boundary. Then it fails closed.
  for (const value of invalid) throws(() => parseDescriptor(value));
  deepStrictEqual(parseDescriptor(golden), golden);
});

Deno.test("canonical descriptor sorts complete tools ordinally independent of input order", () => {
  // Given two declared tools in reverse order.
  const tools = ["zeta", "alpha"].map((id) => ({
    kind: "wasi-tool" as const, toolId: id, sourcePath: `${id}.wasm`,
    sourceSize: 8, sourceSha256: "b".repeat(64), format: "core-module" as const,
    abi: "wasi-p1-blocking-v1" as const, producer: fixtureProducer,
    artifact: { file: `tool-${id === "alpha" ? 0 : 1}.cwasm`, size: 1, sha256: "d".repeat(64) },
  }));
  // When encoding either order. Then the same complete descriptor is selected.
  equal(
    artifactSetId({ ...golden, targets: tools }),
    artifactSetId({ ...golden, targets: [...tools].reverse() }),
  );
});

const aliasedTools: readonly ArtifactTarget[] = ["first", "second"].map(
  (toolId, ordinal) => ({
    kind: "wasi-tool", toolId, sourcePath: "engine.wasm",
    sourceSize: 8, sourceSha256: "b".repeat(64), format: "core-module",
    abi: "wasi-p1-blocking-v1", producer: fixtureProducer,
    artifact: { file: `tool-${ordinal}.cwasm`, size: 16, sha256: "d".repeat(64) },
  }),
);

Deno.test("schema accepts source aliases with distinct tool identities and artifacts", () => {
  // Given two valid declared IDs sharing the exact same source, in reverse order.
  const input = { ...golden, targets: [...aliasedTools].reverse() };
  // When parsing and ordering the descriptor.
  const descriptor = parseDescriptor(input);
  // Then neither source reuse nor equal source/object digests collapse identities.
  deepStrictEqual(
    descriptor.targets.map((t) => [t.toolId, t.sourcePath, t.artifact.file]),
    [
      ["first", "engine.wasm", "tool-0.cwasm"],
      ["second", "engine.wasm", "tool-1.cwasm"],
    ],
  );
});

Deno.test("schema rejects duplicate tool identities even when artifact bindings differ", () => {
  // Given two artifact ordinals claiming the same declared identity.
  const targets = aliasedTools.map((target) => ({ ...target, toolId: "first" }));
  // When parsing. Then the duplicate identity fails independently of source reuse.
  throws(() => parseDescriptor({ ...golden, targets }), /Duplicate target binding/);
});

Deno.test("schema rejects duplicate artifact bindings for distinct source aliases", () => {
  // Given distinct IDs whose generated object filenames collide.
  const targets = aliasedTools.map((target) => ({
    ...target, artifact: { ...target.artifact, file: "tool-0.cwasm" },
  }));
  // When parsing. Then distinct IDs cannot share an artifact binding.
  throws(() => parseDescriptor({ ...golden, targets }), /Mismatched generated artifact path/);
});

for (const [sourceSize, artifactSize] of [[0, 16], [7, 16], [8, 0]]) {
  Deno.test(`schema rejects undersized source/object ${sourceSize}/${artifactSize}`, () => {
    // Given sizes which cannot contain a Wasm source or serialized native object.
    const target = golden.targets[0];
    if (!target) throw new Error("Missing golden target");
    const input = {
      ...golden,
      targets: [{
        ...target, sourceSize,
        artifact: { ...target.artifact, size: artifactSize },
      }],
    };
    // When parsing. Then the host enforces the same lower bounds as the native schema.
    throws(() => parseDescriptor(input));
  });
}
