/// <reference lib="deno.desktop" />
import { join } from "node:path";
import { startDesktop } from "./main.ts";
import type { AssetManifest } from "./package_assets.ts";

export async function packageWindow(
  args: string[],
  assets: string,
  manifest: AssetManifest,
) {
  const desktop = await startDesktop(args, {
    port: 0,
    rendererDirectory: join(assets, "renderer"),
    coreLibrary: join(assets, manifest.core),
    wasmExecutable: join(assets, manifest.wasm),
    ptyLibrary: join(assets, manifest.pty),
    denoRuntime: {
      executable: join(assets, manifest.deno),
      worker: join(assets, "src/modules/runtimes/deno/worker.ts"),
      sdkDirectory: join(assets, "modules-sdk/js"),
    },
  });
  const window = new Deno.BrowserWindow({
    title: "Maghemite",
    width: 1440,
    height: 960,
  });
  window.addEventListener("keydown", (event) => {
    if (
      !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
      event.code !== "KeyN"
    ) return;
    void window.executeJs(
      `(document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, bubbles: true, cancelable: true }))`,
    ).catch((error) => console.error("New file shortcut failed:", error));
  });
  window.addEventListener("close", () => {
    void desktop.stop();
  });
  window.navigate(desktop.url);
}
