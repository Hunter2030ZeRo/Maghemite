import {
  defineModule,
  type Json,
  type LanguageRequest,
  type ModuleContext,
} from "../../../../modules-sdk/js/mod.ts";
import {
  type LanguageSnapshot,
  readLanguageDocument,
} from "../../../../modules-sdk/js/project.ts";
import {
  GATE_PATH,
  IMPORT_TEXT,
  MAIN_PATH,
  projectLanguageFixture,
  TARGET_PATH,
  TOKEN,
} from "./data.ts";

export { projectLanguageFixture } from "./data.ts";

type Snapshot = {
  readonly path: string;
  readonly version: string;
  readonly text: string;
};
type PendingSnapshot = Snapshot & { bytes: number; text: string };
type CommandInput = LanguageRequest | { op: "status" } | {
  op: "gate";
};

const snapshots = new Map<string, Snapshot>();
let pending: PendingSnapshot | undefined;

function assertCommandInput(value: Json): asserts value is CommandInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a project language request");
  }
  if (
    value.op !== "begin" && value.op !== "append" &&
    value.op !== "commit" && value.op !== "query" &&
    value.op !== "status" && value.op !== "gate"
  ) {
    throw new Error("Unknown project language operation");
  }
}

function tokenRange(snapshot: LanguageSnapshot) {
  const from = snapshot.text.indexOf(TOKEN);
  if (from < 0 || snapshot.text.indexOf(TOKEN, from + TOKEN.length) >= 0) {
    throw new Error(`Expected one ${TOKEN} marker in ${snapshot.path}`);
  }
  return { from, to: from + TOKEN.length };
}

function documentVersion(snapshot: LanguageSnapshot) {
  return { path: snapshot.path, version: snapshot.version };
}

async function query(
  input: Extract<LanguageRequest, { readonly op: "query" }>,
  context: ModuleContext,
): Promise<Json> {
  if (!input.project?.id || !input.project.revision) {
    throw new Error("Project context is required");
  }
  const synchronized = snapshots.get(input.path);
  if (
    !synchronized || synchronized.version !== input.version ||
    synchronized.path !== input.path
  ) {
    throw new Error("Source snapshot is not synchronized");
  }
  const [source, target] = await Promise.all([
    readLanguageDocument(context.app.request, MAIN_PATH),
    readLanguageDocument(context.app.request, TARGET_PATH),
  ]);
  if (
    source.path !== input.path ||
    source.version.kind !== "document" ||
    source.version.value !== input.version ||
    source.text !== synchronized.text
  ) {
    throw new Error("Source overlay does not match the synchronized snapshot");
  }
  const sourceRange = tokenRange(source);
  const targetRange = tokenRange(target);
  const reads = [documentVersion(source), documentVersion(target)];
  switch (input.method) {
    case "definition":
      return {
        reads,
        result: [{ ...documentVersion(target), range: targetRange }],
      };
    case "references":
      return {
        reads,
        result: [
          { ...documentVersion(source), range: sourceRange },
          ...(input.includeDeclaration === false
            ? []
            : [{ ...documentVersion(target), range: targetRange }]),
        ],
      };
    case "rename":
      if (!input.newName) throw new Error("Rename requires a new name");
      return {
        reads,
        result: {
          documents: [
            {
              ...documentVersion(source),
              edits: [{ range: sourceRange, text: input.newName }],
            },
            {
              ...documentVersion(target),
              edits: [{ range: targetRange, text: input.newName }],
            },
          ],
        },
      };
    case "completion":
      return {
        reads,
        result: [{
          label: TOKEN,
          insertText: TOKEN,
          detail: "Project fixture item",
          filterText: TOKEN,
          kind: "variable",
          range: sourceRange,
          additionalTextEdits: [{
            range: {
              from: projectLanguageFixture.main.text.indexOf("\r\n") + 2,
              to: projectLanguageFixture.main.text.indexOf("\r\n") + 2,
            },
            text: IMPORT_TEXT,
          }],
        }],
      };
    case "hover":
      return {
        reads,
        result: { text: "project fixture item", range: sourceRange },
      };
    default:
      throw new Error(`Unsupported project fixture feature: ${input.method}`);
  }
}

export default defineModule({
  commands: {
    "test.project-language.query": async (value, context) => {
      assertCommandInput(value);
      switch (value.op) {
        case "status":
          return projectLanguageFixture;
        case "gate":
          await readLanguageDocument(context.app.request, GATE_PATH);
          return null;
        case "begin": {
          const current = snapshots.get(value.path);
          if (current?.version === value.version) {
            return { synchronized: true };
          }
          pending = {
            path: value.path,
            version: value.version,
            bytes: 0,
            text: "",
          };
          return { synchronized: false };
        }
        case "append":
          if (!pending || value.offset !== pending.bytes) {
            throw new Error("Invalid project language snapshot chunk");
          }
          pending.text += value.text;
          pending.bytes += new TextEncoder().encode(value.text).length;
          return null;
        case "commit":
          if (!pending) throw new Error("No project language snapshot");
          snapshots.set(pending.path, {
            path: pending.path,
            version: pending.version,
            text: pending.text,
          });
          pending = undefined;
          return null;
        case "query":
          return await query(value, context);
      }
    },
  },
});
