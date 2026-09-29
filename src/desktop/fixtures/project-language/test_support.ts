import type { Json } from "../../../../modules-sdk/js/mod.ts";
import { documentFromText } from "../../../../renderer/src/workspace/model.ts";
import type { ApplicationServices } from "../../../modules/host/application.ts";
import { fixture as applicationFixture } from "../../../modules/host/application_fixture.ts";
import { ModuleHost } from "../../../modules/host/host.ts";
import { filePath } from "../../../modules/paths.ts";
import { projectLanguageFixture } from "./main.ts";

const fixtureDirectory = filePath(new URL(".", import.meta.url));
export const diskVersion = "target-disk-v1";

export function record(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object result");
  }
  return value;
}

function encode(text: string) {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

export async function createProjectHost() {
  const workbench = applicationFixture();
  const gateStarted = Promise.withResolvers<void>();
  const main = documentFromText(
    projectLanguageFixture.main.path,
    projectLanguageFixture.main.text,
  );
  workbench.documents.push(main);
  const service: ApplicationServices = {
    methods: workbench.service.methods,
    request(method, parameters, caller) {
      if (method !== "files.read") {
        return workbench.service.request(method, parameters, caller);
      }
      const input = record(parameters);
      if (input.path === "gate.fixture") {
        gateStarted.resolve();
        return new Promise((_resolve, reject) => {
          caller.signal.addEventListener(
            "abort",
            () =>
              reject(new DOMException("Fixture gate cancelled", "AbortError")),
            { once: true },
          );
        });
      }
      if (
        input.path !== projectLanguageFixture.target.path ||
        input.offset !== 0 && input.offset !== undefined ||
        input.version !== undefined && input.version !== diskVersion
      ) {
        throw new Error("Unexpected fixture file read");
      }
      return Promise.resolve({
        data: encode(projectLanguageFixture.target.text),
        size: new TextEncoder().encode(projectLanguageFixture.target.text)
          .length,
        version: diskVersion,
        nextOffset: null,
      });
    },
  };
  const host = new ModuleHost({ application: service });
  await host.register(fixtureDirectory, ["documents.read", "files.read"]);
  const provider = host.languageProvider(projectLanguageFixture.main.path);
  if (!provider) throw new Error("Project fixture provider was not registered");
  return { host, provider, workbench, main, gateStarted };
}
