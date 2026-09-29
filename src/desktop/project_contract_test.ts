import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type { Json } from "../../modules-sdk/js/mod.ts";
import { documentFromText } from "../../renderer/src/workspace/model.ts";
import { assertProjectLanguageContract } from "./fixtures/project-language/contract_assertions.ts";
import { projectLanguageFixture } from "./fixtures/project-language/main.ts";
import {
  createProjectHost,
  record,
} from "./fixtures/project-language/test_support.ts";

Deno.test(
  "project fixture returns protocol-2 locations, edits, completion and shared UTF-16 ranges",
  assertProjectLanguageContract,
);

Deno.test("project fixture changes a dependency from disk to document version when opened", async () => {
  const fixture = await createProjectHost();
  try {
    const target = documentFromText(
      projectLanguageFixture.target.path,
      projectLanguageFixture.target.text,
    );
    fixture.workbench.documents.push(target);
    const sourceVersion = fixture.workbench.app.documentVersion(
      fixture.main.id,
    );
    const targetVersion = fixture.workbench.app.documentVersion(target.id);
    const execute = (input: Json) =>
      fixture.host.executeLanguage(
        projectLanguageFixture.main.path,
        fixture.provider.registration,
        input,
        {},
      );
    await execute({
      op: "begin",
      path: projectLanguageFixture.main.path,
      version: sourceVersion,
    });
    await execute({
      op: "append",
      offset: 0,
      text: projectLanguageFixture.main.text,
    });
    await execute({ op: "commit" });
    const response = record(
      await execute({
        op: "query",
        path: projectLanguageFixture.main.path,
        version: sourceVersion,
        method: "definition",
        offset: projectLanguageFixture.main.text.indexOf("item"),
        project: { id: "fixture-workspace", revision: "drafts-2" },
      }),
    );
    const reads = response.reads;
    if (!Array.isArray(reads) || !reads[1]) {
      throw new Error("Expected project dependency reads");
    }
    deepStrictEqual(record(reads[1]).version, {
      kind: "document",
      value: targetVersion,
    });
  } finally {
    await fixture.host.close();
  }
});

Deno.test("project fixture cancellation begins only after its file-read gate", async () => {
  const fixture = await createProjectHost();
  const abort = new AbortController();
  try {
    const task = fixture.host.executeLanguage(
      projectLanguageFixture.main.path,
      fixture.provider.registration,
      { op: "gate" },
      { signal: abort.signal },
    );
    const cancelled = rejects(task, /cancelled/i);
    await Promise.race([
      fixture.gateStarted.promise,
      task.then(() => { throw new Error("Fixture gate was not reached"); }),
    ]);
    abort.abort();
    await cancelled;
    equal(fixture.host.list()[0].state, "registered");
    deepStrictEqual(
      await fixture.host.executeLanguage(
        projectLanguageFixture.main.path,
        fixture.provider.registration,
        { op: "status" },
        {},
      ),
      projectLanguageFixture,
    );
    equal(fixture.host.list()[0].state, "active");
  } finally {
    await fixture.host.close();
  }
});
