const action = Deno.args[0];

if (action === "large") {
  await Deno.stdout.write(new TextEncoder().encode("x".repeat(40_000)));
} else if (action === "wait") {
  Deno.addSignalListener("SIGTERM", () => {});
  await new Promise<void>(() => {});
} else if (action === "mark") {
  await Deno.writeTextFile(Deno.args[1], "started");
}
