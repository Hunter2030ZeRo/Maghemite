/** File URL conversion without requiring Node compatibility or external imports. */
export function filePath(url: URL): string {
  if (url.protocol !== "file:") throw new Error("Expected a local file URL");
  const path = decodeURIComponent(url.pathname);
  if (Deno.build.os !== "windows") return path;
  if (url.hostname) return `\\\\${url.hostname}${path.replaceAll("/", "\\")}`;
  return path.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
}

export function fileUrl(path: string): URL {
  const normalized = Deno.build.os === "windows"
    ? path.replaceAll("\\", "/")
    : path;
  const url = new URL("file:///");
  if (Deno.build.os === "windows" && normalized.startsWith("//")) {
    const slash = normalized.indexOf("/", 2);
    url.hostname = normalized.slice(2, slash);
    url.pathname = normalized.slice(slash);
  } else {url.pathname = normalized.startsWith("/")
      ? normalized
      : `/${normalized}`;}
  return url;
}
