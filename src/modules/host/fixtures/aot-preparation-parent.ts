/** Host-owned crash fixture. Deliberately bypasses disposal to test OS/EOF recovery. */
import { PreparationCoordinator } from "../../runtimes/preparation.ts";
import { ResourceAdmission } from "../resources.ts";
import { frame, frames } from "../../runtimes/protocol.ts";
import { invariant } from "../aot-schema.ts";
import { entries } from "./aot-preparation-support.ts";

const [directory, source, phase, executable] = Deno.args;
invariant(directory && source && executable && (phase === "locked" || phase === "ready"), "Invalid crash fixture arguments");
const resources = new ResourceAdmission({ coreRss: () => 0 });
const coordinator = await PreparationCoordinator.open(directory, { executable, resources });
const reviewed = await coordinator.store.review(source);
await coordinator.prepare(reviewed, {
  operationId: `crash-${phase}`, signal: AbortSignal.timeout(30_000),
  async observe(event) {
    if (event.phase !== phase) return;
    const generationId = resources.inspect().processes[0]?.generationId;
    invariant(generationId, "Missing owned native generation");
    await Deno.stdout.write(frame({
      ...event, generationId, slot: reviewed.slot,
      files: await entries(`${directory}/aot/staging/${generationId}`),
      resources: resources.inspect(),
    }));
    for await (const message of frames(Deno.stdin.readable)) {
      invariant(message.type === "die", "Expected crash command");
      Deno.exit(73);
    }
    Deno.exit(74);
  },
});
throw new Error("Crash fixture must never finish preparation");
