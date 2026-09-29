import { desktopArguments } from "./arguments.ts";
import { defaultDataDirectory } from "./main.ts";
import { filePath } from "../modules/paths.ts";
import { embeddedAssets } from "./package_assets.ts";
import { packageWindow } from "./package_window.ts";

const args = desktopArguments(Deno.args);
const dataDirectory =
  args.find((arg) => arg.startsWith("--data-dir="))?.slice(11) ??
    defaultDataDirectory();
const source = filePath(
  new URL("../../build/desktop-assets/", import.meta.url),
);
const { directory, manifest } = await embeddedAssets(source, dataDirectory);
await packageWindow(args, directory, manifest);
