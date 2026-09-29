// Deterministic external stdio process used to exercise real pipe framing in tests.
const debug = Deno.args.includes("dap");
let buffer = "", sequence = 0;
async function send(message: unknown) {
  const body = JSON.stringify(message),
    frame = `Content-Length: ${
      new TextEncoder().encode(body).length
    }\r\n\r\n${body}`,
    bytes = new TextEncoder().encode(frame);
  await Deno.stdout.write(bytes.slice(0, 9));
  await Deno.stdout.write(bytes.slice(9));
}
for await (const chunk of Deno.stdin.readable) {
  buffer += new TextDecoder().decode(chunk);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) break;
    const size = Number(
      /Content-Length: (\d+)/i.exec(buffer.slice(0, end))![1],
    );
    if (buffer.length < end + 4 + size) break;
    const message = JSON.parse(buffer.slice(end + 4, end + 4 + size));
    buffer = buffer.slice(end + 4 + size);
    const method = debug ? message.command : message.method,
      id = debug ? message.seq : message.id;
    if (method === "hang") continue;
    if (
      debug
        ? message.type === "response"
        : message.method === undefined && message.id !== undefined
    ) {
      await send(
        debug
          ? {
            seq: ++sequence,
            type: "event",
            event: "reverseResponded",
            body: { command: message.command },
          }
          : {
            jsonrpc: "2.0",
            method: "reverseResponded",
            params: message.result,
          },
      );
      continue;
    }
    if (method === "ask") {
      await send(
        debug
          ? {
            seq: 999,
            type: "request",
            command: "runInTerminal",
            arguments: {},
          }
          : {
            jsonrpc: "2.0",
            id: "server-1",
            method: "workspace/configuration",
            params: { items: [] },
          },
      );
    }
    if (id !== undefined && (debug ? message.type === "request" : true)) {
      const result = method === "initialize"
        ? { capabilities: { textDocumentSync: 1 } }
        : { echo: message.params ?? message.arguments ?? null };
      await send(
        debug
          ? {
            seq: ++sequence,
            type: "response",
            request_seq: id,
            command: method,
            success: true,
            body: result,
          }
          : { jsonrpc: "2.0", id, result },
      );
    } else if (
      method === "textDocument/didOpen" || method === "textDocument/didChange"
    ) {
      await send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: message.params.textDocument.uri, diagnostics: [] },
      });
    }
  }
}
