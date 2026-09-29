import {
  deepStrictEqual,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import {
  validateTheme,
  validateThemeCatalog,
} from "../../../modules-sdk/themes/mod.ts";
import { createThemeProject } from "../../../modules-sdk/tooling/theme.ts";
import { createHandler } from "../../desktop/main.ts";
import { ModuleHost } from "./host.ts";
import { loadPackage, validateManifest } from "./manifest.ts";

const manifest = () => ({
  schemaVersion: 1,
  id: "test.theme",
  version: "0.1.0",
  sdkVersion: "0.1.0",
  contributions: {
    themes: [{ id: "test.theme.dark", label: "Test dark", path: "theme.json" }],
  },
});
const theme = () => ({
  schemaVersion: 1,
  base: "graphite",
  colors: { "accent.default": "#abcdef" },
});
async function fixture() {
  const directory = await Deno.makeTempDir({ prefix: "maghemite-theme-" });
  await Deno.writeTextFile(
    `${directory}/maghemite.module.json`,
    JSON.stringify(manifest()),
  );
  await Deno.writeTextFile(`${directory}/theme.json`, JSON.stringify(theme()));
  return directory;
}

Deno.test("theme contract rejects CSS/layout injection, unsupported versions and unbounded radii", () => {
  deepStrictEqual(validateTheme(theme()), theme());
  for (
    const invalid of [
      { ...theme(), schemaVersion: 2 },
      { ...theme(), base: "test.other.dark" },
      { ...theme(), css: "body { display: none }" },
      {
        ...theme(),
        colors: { "surface.background": "url(https://example.com)" },
      },
      { ...theme(), colors: { "--bg": "#fff" } },
      { ...theme(), shape: { "panel.width": 900 } },
      { ...theme(), shape: { "radius.small": -1 } },
      { ...theme(), shape: { "radius.tab": [0, 1, 25, 3] } },
      { ...theme(), shape: { "radius.tab": [0, 1] } },
      { ...theme(), shape: { "radius.small": "50vh" } },
    ]
  ) throws(() => validateTheme(invalid));
  const entry = {
    moduleId: "test.theme",
    id: "test.theme.dark",
    label: "Dark",
    theme: theme(),
  };
  for (
    const themes of [[entry, entry], [{ ...entry, id: "other.theme.dark" }], [{
      ...entry,
      id: "graphite",
    }]]
  ) {
    throws(() => validateThemeCatalog({ schemaVersion: 1, themes }));
  }
});

Deno.test("data-only manifests cannot request capabilities, lifecycle or executable commands", () => {
  const normalized = validateManifest(manifest());
  deepStrictEqual(normalized.capabilities, []);
  deepStrictEqual(normalized.contributions.commands, []);
  for (
    const invalid of [
      { ...manifest(), capabilities: ["log"] },
      { ...manifest(), entry: "main.ts" },
      { ...manifest(), lifecycle: { idleUnload: true } },
      { ...manifest(), wasmProfile: "async" },
      { ...manifest(), runtime: "node" },
      { ...manifest(), runtime: "deno" },
      {
        ...manifest(),
        contributions: { commands: [{ id: "test.theme.run", title: "Run" }] },
      },
      { ...manifest(), contributions: { themes: [] } },
      {
        ...manifest(),
        contributions: {
          themes: [{
            id: "other.theme.dark",
            label: "Dark",
            path: "theme.json",
          }],
        },
      },
      {
        ...manifest(),
        contributions: {
          themes: [{
            id: "test.theme.dark",
            label: "Dark",
            path: "../theme.json",
          }],
        },
      },
    ]
  ) throws(() => validateManifest(invalid));
});

Deno.test("theme fonts accept bounded installed-family lists and reject CSS or layout properties", () => {
  const input = {
    ...theme(),
    fonts: {
      "font.ui": ["Noto Sans", "system-ui"],
      "font.code": ["JetBrains Mono"],
      "font.note": ["나눔 고딕"],
      "font.heading": ["Noto Serif", "serif"],
    },
  };
  const parsed = validateTheme(input);
  deepStrictEqual(parsed.fonts, input.fonts);
  parsed.fonts!["font.code"]!.push("Other Font");
  strictEqual(input.fonts["font.code"].length, 1);
  for (
    const fonts of [
      null,
      [],
      { "font.size": ["18px"] },
      { "font.ui": "Noto Sans" },
      { "font.ui": [] },
      { "font.ui": [null] },
      { "font.ui": [42] },
      { "font.ui": [""] },
      { "font.ui": ["  Noto Sans"] },
      { "font.ui": ["A".repeat(81)] },
      { "font.ui": Array(9).fill("Arial") },
      { "font.ui": ['Arial"; color: red;'] },
      { "font.ui": ["url(https://example.com/a.woff2)"] },
      { "font.ui": ["var(--font-code)"] },
      { "font.ui": ["serif, sans-serif"] },
      { "font.ui": ["Arial\n"] },
      { "font.ui": ["Arial\\"] },
    ]
  ) throws(() => validateTheme({ ...theme(), fonts }));
});

Deno.test({
  name:
    "data-only package registration, HTTP catalog and lifecycle need no process permission",
  permissions: { read: true, write: true, run: false },
  async fn() {
    const directory = await fixture();
    const host = new ModuleHost();
    try {
      await host.register(directory);
      deepStrictEqual(host.commands(), []);
      strictEqual(host.list()[0].state, "registered");
      strictEqual(host.themes().themes[0].id, "test.theme.dark");
      host.themes().themes[0].theme.base = "daylight";
      strictEqual(host.themes().themes[0].theme.base, "graphite");
      const handler = createHandler(host);
      const response = await handler(
        new Request("http://localhost/api/themes"),
      );
      strictEqual(response.headers.get("cache-control"), "no-store");
      deepStrictEqual(await response.json(), host.themes());
      strictEqual(
        (await handler(
          new Request("http://localhost/api/themes", { method: "POST" }),
        )).status,
        405,
      );
      await rejects(() => host.execute("test.theme.run"), /unavailable/);
      await host.disable("test.theme");
      strictEqual(host.themes().themes.length, 0);
      host.enable("test.theme");
      strictEqual(host.themes().themes.length, 1);
      await host.unregister("test.theme");
      strictEqual(host.themes().themes.length, 0);
    } finally {
      await host.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test("package loading rejects oversized files and symlink escapes without partial registration", async () => {
  const directory = await fixture();
  const outside = await Deno.makeTempFile();
  const host = new ModuleHost();
  try {
    await Deno.writeTextFile(`${directory}/theme.json`, " ".repeat(65537));
    await rejects(() => host.register(directory), /too large/);
    deepStrictEqual(host.list(), []);
    await Deno.remove(`${directory}/theme.json`);
    await Deno.writeTextFile(outside, JSON.stringify(theme()));
    await Deno.symlink(outside, `${directory}/theme.json`);
    await rejects(() => host.register(directory), /escapes/);
    deepStrictEqual(host.themes().themes, []);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
    await Deno.remove(outside);
  }
});

Deno.test("a mixed module keeps its theme after guest failure; package disable revokes it", async () => {
  const directory = await fixture();
  const host = new ModuleHost();
  try {
    await Deno.writeTextFile(
      `${directory}/maghemite.module.json`,
      JSON.stringify({
        ...manifest(),
        runtime: "deno",
        entry: "main.ts",
        capabilities: [],
        contributions: {
          ...manifest().contributions,
          commands: [{ id: "test.theme.run", title: "Run" }],
        },
      }),
    );
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      'export default { commands: { "test.theme.run": () => { throw new Error("guest failure"); } } };',
    );
    await host.register(directory);
    await rejects(() => host.execute("test.theme.run"), /guest failure/);
    strictEqual(host.list()[0].state, "failed");
    strictEqual(host.themes().themes.length, 1);
    await host.disable("test.theme");
    strictEqual(host.themes().themes.length, 0);
    host.enable("test.theme");
    strictEqual(host.themes().themes.length, 1);
  } finally {
    await host.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SDK theme scaffold validates without a compiler and never overwrites a directory", async () => {
  const parent = await Deno.makeTempDir();
  try {
    const directory = `${parent}/new-theme`;
    await createThemeProject(directory, "local.theme");
    const pkg = await loadPackage(directory);
    strictEqual(pkg.entry, undefined);
    strictEqual(pkg.themes[0].id, "local.theme.charcoal");
    await rejects(
      () => createThemeProject(directory, "local.theme"),
      Deno.errors.AlreadyExists,
    );
    strictEqual((await loadPackage(directory)).themes.length, 1);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
