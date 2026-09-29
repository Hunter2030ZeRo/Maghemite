export const ATTACHMENT_LIMIT = 2 * 1024 * 1024;

export class AttachmentError extends Error {
  readonly path: string;

  constructor(
    message: string,
    path: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AttachmentError";
    this.path = path;
  }
}

export function validAttachmentPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") &&
    !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

function safeFilename(name: string): string {
  const filename = name.normalize("NFC").split(/[\\/]/).at(-1)?.trim() ?? "";
  const clean = filename.replace(/[\p{Cc}<>:"|?*]/gu, "-").replace(/^\.+/, "");
  const suffix = /\.[^.]{1,16}$/u.exec(clean)?.[0] ?? "";
  const prefix = suffix ? clean.slice(0, -suffix.length) : clean;
  const encoder = new TextEncoder();
  let safe = "", bytes = encoder.encode(suffix).length;
  for (const character of prefix) {
    const size = encoder.encode(character).length;
    if (bytes + size > 120) break;
    safe += character;
    bytes += size;
  }
  safe += suffix;
  if (!safe || safe === "." || safe === "..") {
    throw new AttachmentError("Choose a file with a usable name.", name);
  }
  return safe;
}

export function attachmentDestination(
  notePath: string,
  filename: string,
): { readonly directory: string; readonly path: string; readonly target: string } {
  if (!validAttachmentPath(notePath)) {
    throw new AttachmentError("The note path is not workspace-relative.", notePath);
  }
  const slash = notePath.lastIndexOf("/");
  const parent = slash < 0 ? "" : notePath.slice(0, slash + 1);
  const note = notePath.slice(slash + 1).replace(/\.[^.]+$/, "");
  const directory = `${parent}${note}.attachments`;
  const target = `${note}.attachments/${safeFilename(filename)}`;
  const path = `${parent}${target}`;
  if (!validAttachmentPath(path)) {
    throw new AttachmentError("The attachment path is invalid.", path);
  }
  return { directory, path, target };
}

export function attachmentMarkdown(
  name: string,
  target: string,
  type: string,
): string {
  const label = name.replace(/\p{Cc}/gu, " ").replace(/([\\[\]])/g, "\\$1");
  const escapedTarget = encodeURI(target).replaceAll("#", "%23").replaceAll("?", "%3F");
  const preview = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(type);
  return `${preview ? "!" : ""}[${label}](<${escapedTarget}>)`;
}
