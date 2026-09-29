import { desktopArguments } from "./arguments.ts";
import { installedAssets } from "./package_assets.ts";
import { packageWindow } from "./package_window.ts";

// Resolve the real executable, including launches through /usr/bin symlinks.
// Never search CWD or fall back to build-machine paths for installed resources.
const { directory, manifest } = await installedAssets(Deno.execPath());
await packageWindow(desktopArguments(Deno.args), directory, manifest);
