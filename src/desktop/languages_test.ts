import {
  deepStrictEqual,
  equal,
  match,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { ModuleHost } from "../modules/host/host.ts";
import { validateManifest } from "../modules/host/manifest.ts";
import { filePath } from "../modules/paths.ts";
import { validateLanguageResult, WorkbenchLanguages } from "./languages.ts";
import type { Json } from "../../modules-sdk/js/mod.ts";
import {
  type LanguageToken,
  type LanguageTokenPage,
  languageTokenTypes,
} from "../../modules-sdk/js/language.ts";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
} from "../modules/host/development.ts";

const root = new URL("../../", import.meta.url);
const path = (p: string) => filePath(new URL(p, root));
const executable = path(
  `native/target/release/maghemite-wasm-host${
    Deno.build.os === "windows" ? ".exe" : ""
  }`,
);
const manifest = JSON.parse(
  await Deno.readTextFile(path("modules/rust/maghemite.module.json")),
);
const source =
  "// 한글 😀\r\nstruct Point { x: i32, y: i32 }\r\n/// Doubles a number.\r\nfn twice(value: i32) -> i32 { value * 2 }\r\nfn main() { let point = Point { x: 3, y: 4 }; let answer = twice(point.x); }\r\n";

Deno.test("language manifest requires explicit document access and declared providers", () => {
  equal(validateManifest(manifest).contributions.languages?.[0].id, "rust");
  for (
    const patch of [
      { id: "json" },
      { extensions: [".md"] },
      { command: "missing" },
      { protocol: 99 },
      { features: ["debug"] },
      { scope: "invalid" },
      { unexpected: true },
    ]
  ) {
    const m = structuredClone(manifest);
    Object.assign(m.contributions.languages[0], patch);
    throws(() => validateManifest(m));
  }
  throws(() => validateManifest({ ...manifest, capabilities: [] }));
});

Deno.test("language results reject forged locations and unbounded data", () => {
  const range = { from: 0, to: 4 };
  validateLanguageResult("hover", { range, text: "i32" }, 10, "main.rs");
  for (
    const r of [{ from: -1, to: 3 }, { from: 4, to: 3 }, { from: 0, to: 11 }, {
      from: 0.5,
      to: 3,
    }]
  ) {
    throws(() =>
      validateLanguageResult("hover", { range: r, text: "type" }, 10, "main.rs")
    );
  }
  throws(() =>
    validateLanguageResult(
      "definition",
      [{ range, path: "secret.rs" }],
      10,
      "main.rs",
    )
  );
  throws(() =>
    validateLanguageResult(
      "diagnostics",
      [{ range, message: "bad", severity: "fatal" }],
      10,
      "main.rs",
    )
  );
  throws(() =>
    validateLanguageResult("completion", Array(101).fill(null), 10, "main.rs")
  );
});

Deno.test("semantic token pages reject invalid types, overlap, broken Unicode and cursors", () => {
  validateLanguageResult(
    "semanticTokens",
    { tokens: [[0, 2, 12]], next: 2 },
    10,
    "main.rs",
  );
  for (
    const result of [
      null,
      { tokens: [[0, 1, 99]], next: null },
      { tokens: [[0, 3, 12], [2, 4, 1]], next: null },
      { tokens: [[2, 1, 1]], next: null },
      { tokens: [[0, 11, 1]], next: null },
      { tokens: [[0, 2, 1]], next: 1 },
      { tokens: [], next: 0 },
      { tokens: Array(513).fill([0, 1, 1]), next: null },
    ]
  ) {
    throws(() =>
      validateLanguageResult("semanticTokens", result, 10, "main.rs")
    );
  }
  throws(() =>
    validateLanguageResult(
      "semanticTokens",
      { tokens: [[0, 1, 14]], next: null },
      2,
      "main.rs",
      0,
      "😀",
    )
  );
});

Deno.test("Rust WASM: semantic analysis, unsaved versions, Unicode, permission lifecycle and idle restart", async () => {
  const privateRoot = await Deno.makeTempDir({
    prefix: "maghemite-rust-test-",
  });
  const released: string[] = [];
  const host = new ModuleHost({
    wasmExecutable: executable,
    idleTimeoutMs: 200,
    application: {
      methods() {
        return [];
      },
      request() {
        throw new Error("Analyzer must not request external tools");
      },
      release(owner) {
        released.push(owner);
        return Promise.resolve();
      },
    },
  });
  const bridge = new WorkbenchLanguages();
  const signal = new AbortController().signal;
  let registration: PreparedRegistrationHandle | undefined;
  let reads = 0;
  const request = (
    method: string,
    text = source,
    version = "1",
    offset?: number,
    start?: number,
  ) =>
    bridge.request(host, "main.rs", {
      method,
      version,
      ...(offset === undefined ? {} : { offset }),
      ...(start === undefined ? {} : { start }),
    }, () => {
      reads++;
      return Promise.resolve(text);
    }, signal) as Promise<{ result: Json }>;
  try {
    registration = await prepareRegistration(path("build/modules/rust"), {
      executable,
      storageRoot: privateRoot,
    });
    await host.registerPrepared(registration);
    await rejects(() => request("hover", source, "1", 0), /documents.read/);
    equal(reads, 0);
    equal(host.list()[0].state, "registered");
    await host.unregister("maghemite.rust");
    await host.registerPrepared(registration, ["documents.read"]);
    await request("status");
    equal(
      host.list()[0].state,
      "registered",
      "status must not start an idle guest",
    );
    const status = await host.execute("maghemite.rust.language") as {
      engine: string;
    };
    equal(
      status.engine,
      "rust-analyzer",
      "command palette invocation reports status without failing the module",
    );

    const hover =
      (await request("hover", source, "1", source.indexOf("answer") + 2))
        .result as { text: string; range: { from: number; to: number } };
    match(hover.text, /answer: i32/);
    equal(source.slice(hover.range.from, hover.range.to), "answer");
    const state = await host.execute("maghemite.rust.language", {
      op: "begin",
      path: "main.rs",
      version: "1",
    });
    deepStrictEqual(state, { synchronized: true });
    const functionHover =
      (await request("hover", source, "1", source.lastIndexOf("twice") + 2))
        .result as { text: string };
    match(functionHover.text, /fn twice/);
    match(functionHover.text, /Doubles a number/);
    const definition = (await request(
      "definition",
      source,
      "1",
      source.lastIndexOf("twice") + 2,
    )).result as { range: { from: number; to: number } }[];
    equal(
      source.slice(definition[0].range.from, definition[0].range.to),
      "twice",
    );
    equal(definition[0].range.from, source.indexOf("twice"));
    const completion = (await request(
      "completion",
      source,
      "1",
      source.lastIndexOf("point.x") + 6,
    )).result as { label: string; detail: string; kind: string }[];
    ok(completion.some((i) => i.label === "x" && i.detail === "i32"));
    ok(completion.some((i) => i.label === "y"));
    equal(completion.find((i) => i.label === "x")!.kind, "field");
    deepStrictEqual((await request("diagnostics")).result, []);
    equal(reads, 1, "snapshot is reused for unchanged versions");
    const highlight = (await request("semanticTokens"))
      .result as LanguageTokenPage;
    const at = (text: string, tokens: LanguageToken[], needle: string) => {
      const index = text.indexOf(needle);
      const token = tokens.find(([from, to]) => from <= index && to > index);
      return token ? languageTokenTypes[token[2]] : undefined;
    };
    for (
      const [word, type] of [
        ["한글", "comment"],
        ["struct", "keyword"],
        ["Point", "struct"],
        ["i32", "type"],
        ["twice", "function"],
        ["value", "parameter"],
        ["3,", "number"],
      ]
    ) {
      equal(at(source, highlight.tokens, word), type, word);
    }
    equal(highlight.next, null);
    const multiline =
      '/* outer\r\n /* nested 😀 */ end */\r\nfn main() { let raw = r##"raw\r\n한글 😀"##; }';
    const raw = (await request("semanticTokens", multiline, "raw"))
      .result as LanguageTokenPage;
    equal(at(multiline, raw.tokens, "nested"), "comment");
    equal(at(multiline, raw.tokens, "한글"), "string");
    const many = Array.from(
      { length: 150 },
      (_, i) => `fn value_${i}() -> i32 { ${i} }`,
    ).join("\n");
    const collected: LanguageToken[] = [];
    let cursor = 0, pages = 0;
    do {
      const page =
        (await request("semanticTokens", many, "many", undefined, cursor))
          .result as LanguageTokenPage;
      collected.push(...page.tokens);
      pages++;
      if (page.next === null) break;
      cursor = page.next;
    } while (pages < 20);
    ok(
      pages > 1 && pages < 20,
      "large result must be paged within the SDK frame budget",
    );
    equal(at(many, collected, "value_149"), "function");
    ok(
      collected.every((token, i) => i === 0 || token[0] >= collected[i - 1][1]),
    );
    const changedHighlight = source.replace("struct Point", "enum Point");
    const changed =
      (await request("semanticTokens", changedHighlight, "highlight-edit"))
        .result as LanguageTokenPage;
    equal(
      at(changedHighlight, changed.tokens, "Point"),
      "enum",
      "unsaved changes invalidate highlight cache",
    );
    await rejects(
      () => request("semanticTokens", source, "1", undefined, -1),
      /cursor/,
    );

    const revised = source.replaceAll("i32", "u64");
    match(
      ((await request("hover", revised, "2", revised.indexOf("answer")))
        .result as { text: string }).text,
      /answer: u64/,
    );
    const invalid = 'fn main() { let bad: i32 = "wrong"; }';
    const diagnostics = (await request("diagnostics", invalid, "3")).result as {
      message: string;
    }[];
    ok(
      diagnostics.some((d) => /mismatched|expected.*i32/i.test(d.message)),
      JSON.stringify(diagnostics),
    );
    await rejects(
      () => request("hover", source, "1", source.indexOf("😀") + 1),
      /UTF-16/,
    );
    await rejects(
      () => request("diagnostics", "x".repeat(128 * 1024 + 1), "oversize"),
      /128 KiB/,
    );
    deepStrictEqual((await request("diagnostics", "", "empty")).result, []);
    deepStrictEqual((await request("semanticTokens", "", "empty")).result, {
      tokens: [],
      next: null,
    });
    const large = "// " + "a".repeat(4091) + "😀\n" + source;
    match(
      ((await request("hover", large, "large", large.indexOf("answer")))
        .result as { text: string }).text,
      /answer: i32/,
    );

    // Visible document status keeps only an already-active guest warm.
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await request("status");
      equal(host.list()[0].state, "active");
    }
    // A fresh guest must reconstruct source from the current versioned snapshot.
    const providerOwner = host.languageProvider("main.rs")!.owner;
    const deadline = Date.now() + 5000;
    while (host.list()[0].state !== "suspended" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    equal(host.list()[0].state, "suspended");
    ok(
      !released.includes(providerOwner),
      "idle unload must preserve versioned provider diagnostics",
    );
    match(
      ((await request("hover", revised, "2", revised.indexOf("answer")))
        .result as { text: string }).text,
      /answer: u64/,
    );
    await host.disable("maghemite.rust");
    ok(
      released.includes(providerOwner),
      "disable releases provider diagnostics",
    );
    equal(host.languageProvider("main.rs"), null);
    equal(await request("diagnostics"), null);
    host.enable("maghemite.rust");
    deepStrictEqual((await request("semanticTokens")).result, highlight);
    match(
      ((await request("hover", source, "1", source.indexOf("answer")))
        .result as { text: string }).text,
      /answer: i32/,
    );
    await host.unregister("maghemite.rust");
    await host.registerPrepared(registration);
    const before = reads;
    await rejects(() => request("diagnostics"), /documents.read/);
    equal(reads, before);
  } finally {
    bridge.clear();
    await host.close();
    await registration?.close();
    await Deno.remove(privateRoot, { recursive: true });
  }
});

Deno.test("document synchronization stays compatible with old providers and follows guest restart acknowledgements", async () => {
  const calls: string[] = [];
  let acknowledged: Json = null;
  const provider = {
    moduleId: "test",
    registration: "one",
    owner: "one",
    allowed: true,
    language: { features: ["hover"] },
  };
  const host = {
    languageProvider: () => provider,
    executeLanguage: async (
      _path: string,
      _registration: string,
      input: Json,
    ) => {
      const op = (input as { op: string }).op;
      calls.push(op);
      return op === "begin" ? acknowledged : null;
    },
  } as unknown as ModuleHost;
  const bridge = new WorkbenchLanguages();
  const request = () =>
    bridge.request(
      host,
      "file.rs",
      { method: "hover", version: "v", offset: 0 },
      async () => "fn main() {}",
      new AbortController().signal,
    );
  await request();
  deepStrictEqual(calls, ["begin", "append", "commit", "query"]);
  calls.length = 0;
  acknowledged = { synchronized: true };
  await request();
  deepStrictEqual(calls, ["begin", "query"]);
  calls.length = 0;
  acknowledged = { synchronized: false };
  await request();
  deepStrictEqual(calls, ["begin", "append", "commit", "query"]);
});
