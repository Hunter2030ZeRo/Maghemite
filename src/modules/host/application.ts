import {
  APP_METHODS,
  type AppMethod,
  validateAppRequest,
} from "../../../modules-sdk/js/app.ts";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import { jsonCopy } from "../runtimes/protocol.ts";

export interface ApplicationCaller {
  moduleId: string;
  /** Unforgeable runtime ownership, distinct for worker instances. */
  owner?: string;
  grants?: ReadonlySet<string>;
  signal: AbortSignal;
}

/** Application-owned adapter, never a guest-supplied service or identity. */
export interface ApplicationServices {
  methods(): readonly AppMethod[];
  release?(owner: string): Promise<void>;
  request(
    method: AppMethod,
    parameters: Json,
    caller: ApplicationCaller,
  ): Promise<Json>;
}
export async function applicationRequest(
  services: ApplicationServices | undefined,
  moduleId: string,
  granted: ReadonlySet<string>,
  payload: unknown,
  signal: AbortSignal,
  owner = moduleId,
): Promise<Json> {
  signal.throwIfAborted();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid application request");
  }
  const { method, parameters } = payload as {
    method?: unknown;
    parameters?: unknown;
  };
  validateAppRequest(method, parameters);
  const available = services?.methods() ?? [];
  if (method === "app.describe") {
    return {
      version: 1,
      methods: available.filter((name) =>
        granted.has(APP_METHODS[name]) &&
        extraPermissions(name).every((p) => granted.has(p))
      ),
    };
  }
  if (!granted.has(APP_METHODS[method])) {
    throw new Error(`Capability denied: ${APP_METHODS[method]}`);
  }
  for (const permission of extraPermissions(method)) {
    if (!granted.has(permission)) {
      throw new Error(`Capability denied: ${permission}`);
    }
  }
  if (!services || !available.includes(method)) {
    throw new Error(`Application service unavailable: ${method}`);
  }
  return jsonCopy(
    await services.request(method, jsonCopy(parameters), {
      moduleId,
      owner,
      grants: granted,
      signal,
    }),
  );
}

function extraPermissions(method: string): string[] {
  if (
    [
      "terminal.create",
      "tools.start",
      "formatting.format",
      "linting.lint",
      "language.start",
      "debug.start",
    ].includes(method)
  ) return ["process.execute"];
  if (method === "documents.openFile") return ["documents.write"];
  if (method === "documents.save") return ["documents.read"];
  if (method === "search.replace") return ["files.read"];
  return [];
}
