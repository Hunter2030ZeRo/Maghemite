import { ModuleProcess } from "../process.ts";

export type PreparedWasmComponent = {
  readonly generationDirectory: string;
  readonly artifactSetId: string;
  readonly profile: "async" | "sync";
  readonly resources: "standard" | "compute";
};

export function startWasmModule(
  component: PreparedWasmComponent,
  executable: string,
): ModuleProcess {
  return new ModuleProcess(
    new Deno.Command(executable, {
      args: [
        "--component-aot",
        component.generationDirectory,
        component.artifactSetId,
        component.profile,
        ...(component.resources === "compute"
          ? ["--resource-profile", "compute"]
          : []),
      ],
      clearEnv: true,
      env: { MAGHEMITE_LOAD_NOTIFY: "1" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }),
  );
}
