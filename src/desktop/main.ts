import { NativeApplicationServices } from "../core/services/application.ts";
import { join } from "node:path";
import { ModuleHost } from "../modules/host/host.ts";
import { AotStore } from "../modules/host/aot.ts";
import {
  prepareRegistration,
  type PreparedRegistrationHandle,
  requiresPreparedRegistration,
} from "../modules/host/development.ts";
import { PreparationCoordinator } from "../modules/runtimes/preparation.ts";
import { createRendererHandler } from "./renderer.ts";
import { type InstallationTestOptions, ModuleManager } from "./module_manager.ts";
import { DesktopApplication } from "./application.ts";
import type { Capability } from "../modules/host/manifest.ts";
import { filePath } from "../modules/paths.ts";
import {
  defaultDataDirectory,
  developmentStorageDirectory,
  retainedNativeCacheRoots,
} from "../shared/application_paths.ts";
import {
  type FolderPicker,
  pickFolder,
  WorkspaceHistory,
} from "./workspaces.ts";

export { defaultDataDirectory } from "../shared/application_paths.ts";

/** Authenticated host/workbench seam; module registration remains local host configuration. */
export function createHandler(
  modules: ModuleHost,
  rendererDirectory?: string,
  application?: DesktopApplication,
  origin = "http://127.0.0.1:8000",
) {
  const renderer = createRendererHandler(rendererDirectory);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (application && url.pathname.startsWith("/api/workbench/")) {
      // No CORS, no wildcard hosts and no cookies. Cross-origin pages cannot
      // obtain the bearer secret or connect using a forged DNS host.
      if (
        url.origin !== origin ||
        (req.headers.has("Origin") && req.headers.get("Origin") !== origin)
      ) return new Response("Forbidden", { status: 403 });
      if (
        url.pathname === "/api/workbench/session" && req.method === "GET" &&
        req.headers.get("X-Maghemite-Client") === "1"
      ) {
        return Response.json({ token: application.token }, {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      const protocols = req.headers.get("Sec-WebSocket-Protocol")?.split(",")
        .map((s) => s.trim());
      if (
        url.pathname === "/api/workbench/connect" && req.method === "GET" &&
        req.headers.get("Origin") === origin &&
        req.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
        protocols?.length === 2 && protocols[0] === "maghemite-v1" &&
        protocols[1] === application.token
      ) return application.connect(req, modules);
      return new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/api/themes") {
      if (req.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      return Response.json(modules.themes(), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return await renderer(req);
  };
}

export interface DesktopDefaults {
  pickFolder?: FolderPicker;
  port?: number;
  rendererDirectory?: string;
  coreLibrary?: string;
  wasmExecutable?: string;
  ptyLibrary?: string;
  denoRuntime?:
    import("../modules/runtimes/deno/adapter.ts").DenoRuntimeOptions;
  /** Trusted embedding instrumentation; never accepted from CLI or guest input. */
  installation?: InstallationTestOptions;
}
export async function startDesktop(
  args = Deno.args,
  defaults: DesktopDefaults = {},
) {
  const option = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const allowed = [
    "grant",
    "port",
    "workspace",
    "data-dir",
    "core-library",
    "tools",
    "pty-library",
  ];
  if (
    args.some((arg) =>
      arg.startsWith("--") &&
      !allowed.some((name) => arg.startsWith(`--${name}=`))
    )
  ) throw new Error("Unknown desktop option");
  const port = Number(option("port") ?? defaults.port ?? 8000);
  if (
    !Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))
  ) throw new Error("Invalid port");
  const dataDirectory = option("data-dir") ?? defaultDataDirectory();
  const protectedRoots = [
    developmentStorageDirectory(defaultDataDirectory()),
    ...await retainedNativeCacheRoots(),
  ];
  await Deno.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const lease = await Deno.open(join(dataDirectory, "desktop.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  if (!await lease.tryLock(true)) {
    lease.close();
    throw new Error(
      "This Maghemite profile is already open. Close its running instance or choose a different --data-dir.",
    );
  }
  const history = new WorkspaceHistory(dataDirectory);
  let root = option("workspace");
  if (!root) {
    try {
      const previous = (await history.list())[0];
      if (previous && (await Deno.stat(previous)).isDirectory) root = previous;
    } catch {
      /* Missing/removable recent folders must not prevent launching. */
    }
  }
  const nativeOptions = {
    root,
    dataDirectory,
    protectedRoots,
    coreLibrary: option("core-library") ?? defaults.coreLibrary ??
      filePath(
        new URL(
          `../../native/target/release/${
            Deno.build.os === "windows"
              ? "maghemite_core.dll"
              : Deno.build.os === "darwin"
              ? "libmaghemite_core.dylib"
              : "libmaghemite_core.so"
          }`,
          import.meta.url,
        ),
      ),
    profiles: option("tools")
      ? JSON.parse(await Deno.readTextFile(option("tools")!))
      : [],
    ptyLibrary: option("pty-library") ?? defaults.ptyLibrary,
  };
  const native = await NativeApplicationServices.open(nativeOptions).catch(
    async (error) => {
      if (root && !option("workspace")) {
        console.warn(`Could not reopen last folder: ${String(error)}`);
        return await NativeApplicationServices.open({
          ...nativeOptions,
          root: undefined,
        }).catch((failure) => {
          lease.close();
          throw failure;
        });
      }
      lease.close();
      throw error;
    },
  );
  const application = new DesktopApplication(native);
  application.workspaceControls = {
    history,
    pick: defaults.pickFolder ?? pickFolder,
  };
  if (native.workspace) {
    await history.remember(native.workspace.root).catch(() =>
      console.warn("Could not save recent folder")
    );
  }
  const wasmExecutable = defaults.wasmExecutable ??
    filePath(
        new URL(
          "../../native/target/release/maghemite-wasm-host",
          import.meta.url,
        ),
      ) + (Deno.build.os === "windows" ? ".exe" : "");
  const modules = new ModuleHost({
    application,
    denoRuntime: defaults.denoRuntime,
    wasmExecutable,
  });
  let managedCoordinator: PreparationCoordinator | undefined;
  let developmentCoordinator: PreparationCoordinator | undefined;
  let manager: ModuleManager | undefined;
  let server: ReturnType<typeof Deno.serve> | undefined;
  let maintenance: Promise<unknown> | undefined;
  const developerHandles: PreparedRegistrationHandle[] = [];
  const closeOwned = async () => {
    await manager?.close();
    await maintenance;
    await modules.close();
    for (const handle of developerHandles.toReversed()) await handle.close();
    await developmentCoordinator?.close();
    await managedCoordinator?.close();
    application.close();
    await application.settle();
    await native.close();
    await server?.shutdown();
  };
  try {
    const managedStore = await AotStore.open(
      join(native.options.dataDirectory, "module-packages"),
    );
    managedCoordinator = await PreparationCoordinator.underProfileLock(
      managedStore,
      { executable: wasmExecutable, resources: modules.resources },
    );
    developmentCoordinator = await PreparationCoordinator.open(
      developmentStorageDirectory(native.options.dataDirectory),
      { executable: wasmExecutable, resources: modules.resources },
    );
    const grants = new Map<string, Capability[]>();
    for (const arg of args.filter((a) => a.startsWith("--grant="))) {
      const [id, capability] = arg.slice(8).split(":");
      if (!id || !capability) {
        throw new Error("Use --grant=publisher.module:capability");
      }
      grants.set(id, [...grants.get(id) ?? [], capability as Capability]);
    }
    for (const directory of args.filter((a) => !a.startsWith("--"))) {
      const { loadPackage } = await import("../modules/host/manifest.ts");
      const pkg = await loadPackage(directory);
      const granted = grants.get(pkg.manifest.id) ?? [];
      if (requiresPreparedRegistration(pkg.manifest)) {
        const registration = await prepareRegistration(directory, {
          coordinator: developmentCoordinator,
        });
        await modules.registerPrepared(registration, granted);
        developerHandles.push(registration);
      } else {
        await modules.register(directory, granted);
      }
      grants.delete(pkg.manifest.id);
    }
    if (grants.size) throw new Error("Unknown module grant");
    manager = new ModuleManager(modules, managedCoordinator, defaults.installation);
    await manager.restore();
    application.moduleManager = manager;
    let serve: (request: Request) => Promise<Response>;
    server = Deno.serve({
      hostname: "127.0.0.1",
      port,
      onListen: () => {},
    }, (request) => serve(request));
    const url = `http://127.0.0.1:${server.addr.port}`;
    serve = createHandler(
      modules,
      defaults.rendererDirectory,
      application,
      url,
    );
    console.log(`Maghemite: ${url}/`);
    // Restoration is noncompiling. Only schedule preparation after the renderer
    // handler and listening server are available, and never await it at startup.
    maintenance = manager.maintain().catch((error) => {
      console.warn("Automatic module maintenance needs attention", error);
    });
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        Deno.removeSignalListener("SIGINT", stop);
        if (Deno.build.os !== "windows") {
          Deno.removeSignalListener("SIGTERM", stop);
        }
        try {
          await closeOwned();
          lease.close();
        } catch (error) {
          stopping = undefined;
          Deno.addSignalListener("SIGINT", stop);
          if (Deno.build.os !== "windows") {
            Deno.addSignalListener("SIGTERM", stop);
          }
          throw error;
        }
      })();
      return stopping;
    };
    Deno.addSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGTERM", stop);
    }
    return { url, stop, application, modules };
  } catch (error) {
    try {
      await closeOwned();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Desktop startup cleanup failed; profile ownership retained",
      );
    }
    lease.close();
    throw error;
  }
}
if (import.meta.main) await startDesktop();
