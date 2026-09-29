import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { Json } from "../../../../modules-sdk/js/mod.ts";
import {
  applyLanguageEdits,
  projectBoundary,
  projectEdits,
  projectPosition,
  projectVersion,
  projectWorkspaceEdit,
  sameLanguageVersion,
} from "../../../../modules-sdk/js/project.ts";
import { MAIN_TEXT, TARGET_TEXT } from "./data.ts";
import { projectLanguageFixture } from "./main.ts";
import { createProjectHost, diskVersion, record } from "./test_support.ts";

export async function assertProjectLanguageContract() {
  const fixture = await createProjectHost();
  const execute = (input: Json) =>
    fixture.host.executeLanguage(
      projectLanguageFixture.main.path,
      fixture.provider.registration,
      input,
      {},
    );
  try {
    equal(projectLanguageFixture.main.text, MAIN_TEXT);
    equal(projectLanguageFixture.target.text, TARGET_TEXT);
    deepStrictEqual(
      await fixture.host.execute("test.project-language.query", {
        op: "status",
      }),
      projectLanguageFixture,
    );
    const version = fixture.workbench.app.documentVersion(fixture.main.id);
    deepStrictEqual(
      await execute({
        op: "begin",
        path: projectLanguageFixture.main.path,
        version,
      }),
      { synchronized: false },
    );
    equal(
      await execute({
        op: "append",
        offset: 0,
        text: projectLanguageFixture.main.text,
      }),
      null,
    );
    equal(await execute({ op: "commit" }), null);
    deepStrictEqual(
      await execute({
        op: "begin",
        path: projectLanguageFixture.main.path,
        version,
      }),
      { synchronized: true },
    );

    const sourceRange = {
      from: projectLanguageFixture.main.text.indexOf(
        projectLanguageFixture.token,
      ),
      to: projectLanguageFixture.main.text.indexOf(
        projectLanguageFixture.token,
      ) + projectLanguageFixture.token.length,
    };
    const targetRange = {
      from: projectLanguageFixture.target.text.indexOf(
        projectLanguageFixture.token,
      ),
      to: projectLanguageFixture.target.text.indexOf(
        projectLanguageFixture.token,
      ) + projectLanguageFixture.token.length,
    };
    const reads = [
      {
        path: projectLanguageFixture.main.path,
        version: { kind: "document", value: version },
      },
      {
        path: projectLanguageFixture.target.path,
        version: { kind: "disk", value: diskVersion },
      },
    ];
    const query = (
      method: "definition" | "references" | "rename" | "completion" | "hover",
      extra: Record<string, Json> = {},
    ) =>
      execute({
        op: "query",
        path: projectLanguageFixture.main.path,
        version,
        method,
        offset: sourceRange.from,
        project: { id: "fixture-workspace", revision: "drafts-1" },
        ...extra,
      });

    deepStrictEqual(await query("definition"), {
      reads,
      result: [{ ...reads[1], range: targetRange }],
    });
    deepStrictEqual(
      await query("references", { includeDeclaration: false }),
      {
        reads,
        result: [{ ...reads[0], range: sourceRange }],
      },
    );
    deepStrictEqual(
      await query("references", { includeDeclaration: true }),
      {
        reads,
        result: [
          { ...reads[0], range: sourceRange },
          { ...reads[1], range: targetRange },
        ],
      },
    );

    const rename = record(await query("rename", { newName: "renamed" }));
    const workspaceEdit = projectWorkspaceEdit(rename.result);
    equal(
      applyLanguageEdits(
        projectLanguageFixture.main.text,
        workspaceEdit.documents[0].edits,
      ),
      projectLanguageFixture.main.text.replace("item", "renamed"),
    );
    equal(
      applyLanguageEdits(
        projectLanguageFixture.target.text,
        workspaceEdit.documents[1].edits,
      ),
      projectLanguageFixture.target.text.replace("item", "renamed"),
    );

    const completion = record(await query("completion"));
    const items = completion.result;
    if (!Array.isArray(items) || !items[0]) {
      throw new Error("Expected fixture completion");
    }
    const item = record(items[0]);
    const primary = projectEdits([{
      range: item.range,
      text: item.insertText,
    }], projectLanguageFixture.main.text);
    const additional = projectEdits(
      item.additionalTextEdits,
      projectLanguageFixture.main.text,
    );
    equal(
      applyLanguageEdits(
        projectLanguageFixture.main.text,
        [...additional, ...primary],
      ),
      `// 프로젝트 😀\r\n${projectLanguageFixture.importText}\r\nitem\r\n`,
    );
    deepStrictEqual(
      projectPosition(projectLanguageFixture.main.text, sourceRange.from),
      { line: 3, column: 0 },
    );
    deepStrictEqual(
      projectPosition(projectLanguageFixture.target.text, targetRange.from),
      { line: 2, column: 8 },
    );
    throws(
      () =>
        projectBoundary(
          projectLanguageFixture.main.text,
          projectLanguageFixture.main.text.indexOf("😀") + 1,
        ),
      /Unicode/,
    );
    throws(
      () =>
        projectBoundary(
          projectLanguageFixture.main.text,
          projectLanguageFixture.main.text.indexOf("\r\n") + 1,
        ),
      /CRLF/,
    );
    ok(
      !sameLanguageVersion(
        projectVersion(reads[0].version),
        projectVersion(reads[1].version),
      ),
    );
  } finally {
    await fixture.host.close();
  }
}
