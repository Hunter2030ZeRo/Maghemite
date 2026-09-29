import { ok } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppAPI } from "../../../modules-sdk/js/app.ts";
import type {
  SearchMatch,
  SearchOptions,
} from "../../../modules-sdk/js/search.ts";
import { applicationRequest } from "../../modules/host/application.ts";
import { NativeApplicationServices } from "./application.ts";

const coreLibrary = fileURLToPath(
  new URL(
    "../../../native/target/release/libmaghemite_core.so",
    import.meta.url,
  ),
);

export async function fixture() {
  const temporary = await Deno.makeTempDir({
    prefix: "maghemite-search-service-",
  });
  const root = join(temporary, "workspace");
  await Deno.mkdir(root);
  const service = await NativeApplicationServices.open({
    root,
    dataDirectory: join(temporary, "data"),
    coreLibrary,
  });
  const api = (
    owner = "search-runtime",
    grants = new Set(["files.read", "files.write"]),
    signal = AbortSignal.timeout(15000),
  ) =>
    createAppAPI((method, parameters) =>
      applicationRequest(
        service,
        "test.search",
        grants,
        { method, parameters },
        signal,
        owner,
      )
    );
  return {
    root,
    service,
    api,
    async close() {
      await service.close();
      await Deno.remove(temporary, { recursive: true });
    },
  };
}

type API = ReturnType<Awaited<ReturnType<typeof fixture>>["api"]>;
export async function collect(api: API, options: SearchOptions) {
  const { search } = await api.search.start(options);
  const matches: SearchMatch[] = [];
  let cursor = 0;
  for (;;) {
    const page = await api.search.read({ search, cursor });
    ok(new TextEncoder().encode(JSON.stringify(page)).length < 48 * 1024);
    matches.push(...page.matches);
    cursor = page.cursor;
    if (page.done) return { search, matches, page };
  }
}
