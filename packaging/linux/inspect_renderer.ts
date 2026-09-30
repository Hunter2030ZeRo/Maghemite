const response = await fetch("http://127.0.0.1:9222/json/list");
const targets = await response.json() as {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}[];
const target = targets.find((item) =>
  item.type === "page" && item.url.startsWith("http://127.0.0.1:")
);
if (!target) throw new Error("Maghemite renderer target missing");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = reject;
});
const result = Promise.race([
  new Promise<boolean>((resolve, reject) => {
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      resolve(message.result?.result?.value === true);
    };
    ws.onerror = reject;
  }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("CDP timeout")), 5000)
  ),
]);
ws.send(JSON.stringify({
  id: 1,
  method: "Runtime.evaluate",
  params: {
    expression: "!!document.querySelector('dialog.new-code-dialog[open]')",
    returnByValue: true,
  },
}));
console.log(await result);
ws.close();
