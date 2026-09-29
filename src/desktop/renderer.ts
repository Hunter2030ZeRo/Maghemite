import { filePath } from "../modules/paths.ts";

const defaultDirectory = filePath(
  new URL("../../renderer/dist/", import.meta.url),
);
const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
};

/** Serve only the built renderer. Package files and repository sources stay private. */
export function createRendererHandler(directory = defaultDirectory) {
  return async (request: Request): Promise<Response> => {
    const reply = (message: string, status: number) =>
      new Response(request.method === "HEAD" ? null : message, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return reply("Invalid path", 400);
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    if (
      relative.includes("\\") || relative.includes("\0") ||
      relative.split("/").some((part) => !part || part.startsWith("."))
    ) return reply("Not found", 404);
    let file: Deno.FsFile | undefined;
    try {
      // Resolve on each request so a build completed after startup becomes available.
      const root = await Deno.realPath(directory);
      const path = await Deno.realPath(`${root}/${relative}`);
      const separator = Deno.build.os === "windows" ? "\\" : "/";
      if (!path.startsWith(`${root}${separator}`)) {
        return reply("Not found", 404);
      }
      file = await Deno.open(path, { read: true });
      const info = await file.stat();
      if (!info.isFile) {
        file.close();
        return reply("Not found", 404);
      }
      const headers = {
        "Content-Type": contentTypes[relative.split(".").pop() ?? ""] ??
          "application/octet-stream",
        "Content-Length": String(info.size),
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      };
      if (request.method === "HEAD") {
        file.close();
        return new Response(null, { headers });
      }
      return new Response(file.readable, { headers });
    } catch (error) {
      file?.close();
      if (error instanceof Deno.errors.NotFound) {
        return relative === "index.html"
          ? reply(
            "Maghemite UI has not been built. Run 'deno task build' in the Maghemite repository, then refresh this page.",
            503,
          )
          : reply("Not found", 404);
      }
      if (error instanceof Deno.errors.NotADirectory) {
        return reply("Not found", 404);
      }
      throw error;
    }
  };
}
