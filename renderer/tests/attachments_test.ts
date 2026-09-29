import {
  deepStrictEqual as eq,
  match,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import type { Json } from "../../modules-sdk/js/mod.ts";
import {
  ATTACHMENT_LIMIT,
  ATTACHMENT_MEMORY_LIMIT,
  attachmentMemoryBytes,
  attachmentDestination,
  attachmentMarkdown,
  createAttachments,
  createAttachmentResourceReporter,
  releaseAttachmentUrl,
  retainAttachmentUrl,
} from "../src/workspace/attachments.ts";
import { renderMarkdown } from "../src/workspace/markdown.ts";

Deno.test("attachment names preserve URL delimiters and bracket labels through Markdown", () => {
  // Given a real filename containing characters with Markdown/URL meaning.
  const name = "[한글]#100%.png";
  const destination = attachmentDestination("notes/Plan.md", name);
  // When its insertion text passes through the shipped renderer.
  const html = renderMarkdown(attachmentMarkdown(name, destination.target, "image/png"), {
    documentId: "notes/Plan.md", currentPath: "notes/Plan.md", documents: [],
  });
  // Then the image addresses the actual filename, not a fragment or broken label.
  strictEqual(html.includes(`data-attachment="${destination.path}"`), true);
});

Deno.test("long attachment names keep a complete Unicode character and image extension", () => {
  // Given an image name crossing the filename truncation boundary.
  const destination = attachmentDestination("Plan.md", "x".repeat(119) + "😀.png");
  // When the generated path is encoded for a link.
  encodeURIComponent(destination.path);
  // Then it remains a portable filename with a usable image extension.
  strictEqual(destination.path.endsWith(".png"), true);
  strictEqual(new TextEncoder().encode(destination.path.split("/").at(-1)).length <= 120, true);
});

Deno.test("attachment downloads preserve arbitrary binary without executable MIME", async () => {
  // Given a non-image attachment with binary bytes.
  const bytes = new Uint8Array([0, 255, 13, 10]);
  const files = createAttachments(() => Promise.resolve({
    data: btoa(String.fromCharCode(...bytes)), size: bytes.length,
    version: "v1", nextOffset: null,
  }));
  // When downloaded, not previewed as markup.
  const blob = await files.download("Plan.attachments/archive.zip");
  // Then content remains exact and its MIME cannot execute as HTML or SVG.
  eq(new Uint8Array(await blob.arrayBuffer()), bytes);
  eq(blob.type, "application/octet-stream");
  eq(attachmentMarkdown("drawing.svg", "Plan.attachments/drawing.svg", "image/svg+xml"),
    "[drawing.svg](<Plan.attachments/drawing.svg>)");
});

Deno.test("attachment URL reservations share a budget and release capacity", () => {
  // Given a live preview using the shared URL budget.
  const url = retainAttachmentUrl(new Blob([new Uint8Array(ATTACHMENT_MEMORY_LIMIT)]), "large.png");
  try {
    // When a second view tries to retain another byte.
    throws(() => retainAttachmentUrl(new Blob(["x"]), "next.png"), /budget/);
    // Then the first reservation remains intact.
    eq(attachmentMemoryBytes(), ATTACHMENT_MEMORY_LIMIT);
  } finally {
    releaseAttachmentUrl(url);
  }
  eq(attachmentMemoryBytes(), 0);
});

Deno.test("attachment memory reports coalesce changes and stop with their connection", async () => {
  const first = Promise.withResolvers<Json>(), next = Promise.withResolvers<void>();
  const reports: Json[] = [], errors: unknown[] = [];
  const reporter = createAttachmentResourceReporter((method, parameters) => {
    eq(method, "modules.rendererResources");
    reports.push(parameters);
    if (reports.length === 1) return first.promise;
    next.resolve();
    return Promise.resolve(null);
  }, (error) => errors.push(error));
  const initial = reporter.start();
  const a = retainAttachmentUrl(new Blob(["a"]), "a.png");
  const b = retainAttachmentUrl(new Blob(["bc"]), "b.png");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Resource report did not finish")), 2000);
  });
  try {
    releaseAttachmentUrl(a);
    eq(reports.length, 1);
    first.resolve(null);
    await Promise.race([next.promise, deadline]);
    await Promise.race([initial, deadline]);
    eq(reports.map((report) => field(report, "attachmentBytes")), [0, 2]);
    eq(field(reports[1], "attachmentLimitBytes"), ATTACHMENT_MEMORY_LIMIT);
    reporter.stop();
    releaseAttachmentUrl(b);
    eq(reports.length, 2);
    await Promise.race([reporter.start(), deadline]);
    eq(field(reports[2], "attachmentBytes"), 0);
    eq(errors, []);
  } finally {
    clearTimeout(timer);
    reporter.stop();
    first.resolve(null);
    releaseAttachmentUrl(a);
    releaseAttachmentUrl(b);
    await initial;
  }
});

Deno.test("attachment cancellation during the final read does not return a Blob", async () => {
  // Given a read cancelled by its owner before its final response is delivered.
  const controller = new AbortController();
  const attachments = createAttachments(() => {
    controller.abort();
    return Promise.resolve({ data: btoa("x"), size: 1, version: "v1", nextOffset: null });
  });
  // When that response arrives, no preview resource is materialized.
  await rejects(attachments.read("image.png", controller.signal), { name: "AbortError" });
});

function field(parameters: Json, key: string): Json | undefined {
  if (
    parameters === null || typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) return;
  return parameters[key];
}

Deno.test("attachment reads pin versions and assemble bounded binary chunks", async () => {
  // Given a two-page binary file whose second read requires the first version.
  const calls: { method: string; parameters: Json }[] = [];
  const bytes = new Uint8Array([0, 1, 2, 200, 255]);
  const attachments = createAttachments((method, parameters): Promise<Json> => {
    calls.push({ method, parameters });
    const offset = field(parameters, "offset");
    if (method !== "files.read") return Promise.reject(new Error(`Unexpected ${method}`));
    return Promise.resolve(offset === 0
      ? { data: btoa(String.fromCharCode(...bytes.subarray(0, 2))), size: 5, version: "v1", nextOffset: 2 }
      : { data: btoa(String.fromCharCode(...bytes.subarray(2))), size: 5, version: "v1", nextOffset: null });
  });
  // When the image is loaded.
  const blob = await attachments.read("notes/media/picture.png");
  // Then exact bytes and version-consistent continuation are observed.
  eq(new Uint8Array(await blob.arrayBuffer()), bytes);
  strictEqual(blob.type, "image/png");
  strictEqual(field(calls[1].parameters, "version"), "v1");
  strictEqual(field(calls[1].parameters, "offset"), 2);
});

Deno.test("attachment reads reject version changes invalid offsets and limits", async () => {
  // Given independently malformed read sequences.
  const cases = [
    {
      first: { data: btoa("a"), size: 2, version: "v1", nextOffset: 1 },
      second: { data: btoa("b"), size: 2, version: "v2", nextOffset: null },
      message: /changed/,
    },
    {
      first: { data: btoa("a"), size: 2, version: "v1", nextOffset: 2 },
      second: { data: btoa("b"), size: 2, version: "v1", nextOffset: null },
      message: /offset/,
    },
    {
      first: { data: "", size: ATTACHMENT_LIMIT + 1, version: "v1", nextOffset: null },
      second: null,
      message: /preview limit/,
    },
  ];
  for (const fixture of cases) {
    let count = 0;
    const attachments = createAttachments((method): Promise<Json> => {
      if (method !== "files.read") return Promise.reject(new Error(`Unexpected ${method}`));
      return Promise.resolve(count++ === 0 ? fixture.first : fixture.second);
    });
    await rejects(() => attachments.read("image.png"), fixture.message);
  }
});

Deno.test("attachment upload stages chunks without overwrite and returns insertion text", async () => {
  // Given a workspace file API that records a staged write.
  const calls: { method: string; parameters: Json }[] = [];
  const size = 20_000;
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  const attachments = createAttachments((method, parameters): Promise<Json> => {
    calls.push({ method, parameters });
    if (method === "files.mkdir") return Promise.resolve(null);
    if (method === "files.beginWrite") return Promise.resolve({ upload: "upload-1" });
    if (method === "files.writeChunk") {
      const offset = field(parameters, "offset");
      const data = field(parameters, "data");
      if (typeof offset !== "number" || typeof data !== "string") {
        return Promise.reject(new Error("Invalid test write"));
      }
      return Promise.resolve({ offset: offset + atob(data).length });
    }
    if (method === "files.commitWrite") {
      return Promise.resolve({ version: "v1", size });
    }
    return Promise.reject(new Error(`Unexpected ${method}`));
  });
  // When a local image is uploaded.
  const result = await attachments.upload("notes/Plan.md", {
    name: "diagram 1.png",
    size,
    type: "image/png",
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  });
  // Then the destination is note-local, creation forbids overwrite, chunks are
  // transport-safe, and the returned edit text references that file.
  eq(result, {
    path: "notes/Plan.attachments/diagram 1.png",
    target: "Plan.attachments/diagram 1.png",
    markdown: "![diagram 1.png](<Plan.attachments/diagram%201.png>)",
  });
  const begin = calls.find((call) => call.method === "files.beginWrite");
  strictEqual(field(begin?.parameters ?? null, "version"), null);
  strictEqual(field(begin?.parameters ?? null, "path"), result.path);
  eq(
    calls.filter((call) => call.method === "files.writeChunk")
      .map((call) => field(call.parameters, "offset")),
    [0, 16 * 1024],
  );
});

Deno.test("failed attachment uploads abort their owned stage", async () => {
  // Given a write that fails after staging.
  const calls: string[] = [];
  const attachments = createAttachments((method): Promise<Json> => {
    calls.push(method);
    if (method === "files.mkdir") return Promise.resolve(null);
    if (method === "files.beginWrite") return Promise.resolve({ upload: "owned" });
    if (method === "files.writeChunk") return Promise.reject(new Error("transport failed"));
    if (method === "files.abortWrite") return Promise.resolve(null);
    return Promise.reject(new Error(`Unexpected ${method}`));
  });
  // When upload fails.
  await rejects(
    () =>
      attachments.upload("Plan.md", {
        name: "file.bin",
        size: 1,
        type: "application/octet-stream",
        arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
      }),
    /transport failed/,
  );
  // Then the stage is explicitly released.
  eq(calls.slice(-2), ["files.writeChunk", "files.abortWrite"]);
});

Deno.test("attachment paths and uploads reject traversal collisions and oversize input", async () => {
  // Given unsafe paths, an existing destination, and an oversized input.
  throws(
    () => attachmentDestination("../Plan.md", "file.png"),
    /workspace-relative/,
  );
  let arrayRead = false;
  const conflict = createAttachments((method): Promise<Json> => {
    if (method === "files.mkdir") return Promise.resolve(null);
    if (method === "files.beginWrite") {
      return Promise.reject(new Error("version conflict"));
    }
    return Promise.reject(new Error(`Unexpected ${method}`));
  });
  // When each boundary is attempted, then no overwrite or oversized read occurs.
  await rejects(
    () =>
      conflict.upload("Plan.md", {
        name: "file.png",
        size: 1,
        type: "image/png",
        arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
      }),
    /without overwriting/,
  );
  await rejects(
    () =>
      conflict.upload("Plan.md", {
        name: "huge.bin",
        size: ATTACHMENT_LIMIT + 1,
        type: "application/octet-stream",
        arrayBuffer: () => {
          arrayRead = true;
          return Promise.resolve(new ArrayBuffer(0));
        },
      }),
    /upload limit/,
  );
  strictEqual(arrayRead, false);
  match(attachmentDestination("notes/Plan.md", "..\\evil.png").path, /evil\.png$/);
});
