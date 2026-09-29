import { deepStrictEqual as eq, rejects, throws } from "node:assert/strict";
import { WorkbenchPreferences } from "./preferences.ts";
import {
  effectivePreferences,
  validateLayer,
  validatePreference,
} from "../shared/preferences.ts";

Deno.test("preferences persist, inherit, reset and isolate workspace overrides", async () => {
  const dir = await Deno.makeTempDir();
  const signal = new AbortController().signal;
  try {
    let store = new WorkbenchPreferences(dir);
    await store.update("project-a", {
      scope: "user",
      key: "editorFontSize",
      value: 16,
      version: null,
    }, signal);
    const override = await store.update("project-a", {
      scope: "workspace",
      key: "editorFontSize",
      value: 20,
      version: null,
    }, signal);
    store = new WorkbenchPreferences(dir);
    const a = await store.get("project-a"), b = await store.get("project-b");
    eq(
      effectivePreferences(a.user.values, a.workspace.values).editorFontSize,
      20,
    );
    eq(
      effectivePreferences(b.user.values, b.workspace.values).editorFontSize,
      16,
    );
    await store.update("project-a", {
      scope: "workspace",
      key: "editorFontSize",
      reset: true,
      version: override.version,
    }, signal);
    const reset = await store.get("project-a");
    eq(
      effectivePreferences(reset.user.values, reset.workspace.values)
        .editorFontSize,
      16,
    );
    await rejects(
      () =>
        store.update("project-a", {
          scope: "user",
          key: "editorFontSize",
          value: 18,
          version: null,
        }, signal),
      /changed elsewhere/,
    );
    await rejects(
      () =>
        store.update(null, {
          scope: "workspace",
          key: "wordWrap",
          value: true,
          version: null,
        }, signal),
      /Open a workspace/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preference validation rejects unsupported keys, invalid limits and CSS injection", () => {
  for (const value of [NaN, 0, 200, "12", 12.5]) {
    throws(() => validatePreference("editorFontSize", value));
  }
  for (
    const value of [
      "serif; color:red",
      "url(https://example.com/font)",
      "<style>",
      "a\nbody",
    ]
  ) throws(() => validatePreference("editorFont", value));
  throws(() => validateLayer({ __unexpected: true }));
  throws(() => validateLayer(JSON.parse('{"__proto__":{}}')));
  validatePreference("editorFont", '"Fira Code", monospace');
  validatePreference("noteFont", "");
  validatePreference("wordWrap", true);
});

Deno.test("parallel stale settings updates cannot silently overwrite a newer record", async () => {
  const dir = await Deno.makeTempDir(), signal = new AbortController().signal;
  try {
    const store = new WorkbenchPreferences(dir);
    const results = await Promise.allSettled([
      store.update(null, {
        scope: "user",
        key: "wordWrap",
        value: true,
        version: null,
      }, signal),
      store.update(null, {
        scope: "user",
        key: "tabSize",
        value: 4,
        version: null,
      }, signal),
    ]);
    eq(results.map((r) => r.status), ["fulfilled", "rejected"]);
    eq((await store.get(null)).user.values, { wordWrap: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
