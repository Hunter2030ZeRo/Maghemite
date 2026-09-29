/// <reference lib="deno.desktop" />
import { desktopArguments } from "./arguments.ts";
import { startDesktop } from "./main.ts";
const args = desktopArguments(Deno.args);
const desktop = await startDesktop(args, { port: 0 });
const window = new Deno.BrowserWindow({
  title: "Maghemite",
  width: 1440,
  height: 960,
});
window.addEventListener("close", () => {
  void desktop.stop();
});
window.navigate(desktop.url);
