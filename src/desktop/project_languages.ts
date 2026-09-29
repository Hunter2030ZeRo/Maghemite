import type { Json } from "../../modules-sdk/js/mod.ts";
import {
  LANGUAGE_SOURCE_LIMIT,
  type LanguageDocumentVersion,
  type LanguageSnapshot,
  type LanguageVersion,
  type LanguageWorkspaceEdit,
  PROJECT_RESULT_LIMIT,
  PROJECT_TEXT_LIMIT,
  projectDocument,
  projectEdits,
  projectPosition,
  projectRange,
  projectRecord,
  projectWorkspaceEdit,
  sameLanguageVersion,
} from "../../modules-sdk/js/project.ts";
import type { ModuleHost } from "../modules/host/host.ts";

export type ProjectContext = { id: string; revision: string };
export interface LanguageProjectAccess {
  context(): Promise<ProjectContext>;
  read(path: string, version: LanguageVersion): Promise<LanguageSnapshot>;
  commit(
    revision: string,
    edit: LanguageWorkspaceEdit,
    snapshots: readonly LanguageSnapshot[],
    selection?: { path: string; from: number; to: number },
  ): Promise<Json>;
}
type Proposal = {
  expires: number;
  path: string;
  registration: string;
  context: ProjectContext;
  reads: LanguageDocumentVersion[];
  edit?: LanguageWorkspaceEdit;
  locations?: { path: string; from: number; to: number }[];
};

/** Holds bounded proposals, never an analysis engine or a persistent file cache. */
export class ProjectLanguages {
  #proposals = new Map<string, Proposal>();
  clear() {
    this.#proposals.clear();
  }
  async #snapshots(reads: readonly LanguageDocumentVersion[], access: LanguageProjectAccess) {
    const snapshots = new Map<string, LanguageSnapshot>();
    let bytes = 0;
    for (const d of reads) {
      const snapshot = await access.read(d.path, d.version);
      if (!sameLanguageVersion(snapshot.version, d.version)) {
        throw new Error(`Language version conflict: ${d.path}; request the operation again`);
      }
      const size = new TextEncoder().encode(snapshot.text).length;
      bytes += size;
      if (size > LANGUAGE_SOURCE_LIMIT || bytes > PROJECT_TEXT_LIMIT) {
        throw new Error("Project analysis limit: 128 KiB per file, 2 MB total");
      }
      snapshots.set(d.path, snapshot);
    }
    return snapshots;
  }
  async #current(context: ProjectContext, access: LanguageProjectAccess, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = await access.context();
    signal.throwIfAborted();
    if (current.id !== context.id || current.revision !== context.revision) {
      throw new Error("Project changed; request the language operation again");
    }
  }
  async accept(
    raw: Json,
    method: string,
    path: string,
    version: string,
    registration: string,
    context: ProjectContext,
    access: LanguageProjectAccess,
    signal: AbortSignal,
    validateLocal: (result: Json) => void,
  ): Promise<Json> {
    if (new TextEncoder().encode(JSON.stringify(raw)).length > PROJECT_RESULT_LIMIT) {
      throw new Error("Project result exceeds 32 KiB; narrow the operation");
    }
    const envelope = projectRecord(raw);
    if (!Array.isArray(envelope.reads) || envelope.reads.length > 100) {
      throw new Error("Project results require at most 100 versioned dependencies");
    }
    const reads = envelope.reads.map(projectDocument);
    if (new Set(reads.map((d) => d.path)).size !== reads.length) {
      throw new Error("Duplicate project dependency");
    }
    if (!reads.some((d) => d.path === path &&
      d.version.kind === "document" && d.version.value === version)) {
      throw new Error("Project result must depend on the requested document version");
    }
    const snapshots = await this.#snapshots(reads, access);
    const target = (value: unknown) => {
      const d = projectDocument(value), snapshot = snapshots.get(d.path);
      if (!snapshot || !sameLanguageVersion(snapshot.version, d.version)) {
        throw new Error(`Missing versioned project dependency: ${d.path}`);
      }
      return snapshot;
    };
    const proposal: Proposal = {
      expires: Date.now() + 30000, path, registration, context, reads,
    };
    let result: Json;
    if (method === "definition" || method === "references") {
      if (!Array.isArray(envelope.result) || envelope.result.length > 100) {
        throw new Error("Project location limit is 100");
      }
      proposal.locations = [];
      result = envelope.result.map((value) => {
        const snapshot = target(value);
        const range = projectRange(projectRecord(value).range, snapshot.text);
        proposal.locations?.push({ path: snapshot.path, ...range });
        return {
          path: snapshot.path, version: { ...snapshot.version }, range: { ...range },
          selection: {
            start: projectPosition(snapshot.text, range.from),
            end: projectPosition(snapshot.text, range.to),
          },
        };
      });
    } else if (method === "rename") {
      const edit = projectWorkspaceEdit(envelope.result);
      proposal.edit = edit;
      result = {
        documents: edit.documents.map((d) => {
          const snapshot = target(d);
          const edits = projectEdits(d.edits, snapshot.text);
          return {
            path: d.path, version: { ...d.version },
            edits: edits.map((e) => ({
              ...e, range: { ...e.range },
              selection: {
                start: projectPosition(snapshot.text, e.range.from),
                end: projectPosition(snapshot.text, e.range.to),
              },
            })),
          };
        }),
      };
    } else {
      result = envelope.result as Json;
      validateLocal(result);
      if (method === "completion" && Array.isArray(result)) {
        const source = snapshots.get(path);
        if (!source) throw new Error("Missing project source");
        for (const value of result) {
          const item = projectRecord(value);
          const primary = projectRange(item.range, source.text);
          if (item.additionalTextEdits !== undefined) {
            const additional = projectEdits(item.additionalTextEdits, source.text);
            projectEdits([
              { range: primary, text: item.insertText },
              ...additional,
            ].sort((a, b) => a.range.from - b.range.from), source.text);
          }
        }
      }
    }
    await this.#current(context, access, signal);
    if (proposal.edit || proposal.locations?.length) {
      for (const [id, entry] of this.#proposals) {
        if (entry.expires < Date.now()) this.#proposals.delete(id);
      }
      while (this.#proposals.size >= 8) {
        const oldest = this.#proposals.keys().next().value;
        if (oldest) this.#proposals.delete(oldest);
      }
      const id = crypto.randomUUID();
      const resolved = (Array.isArray(result)
        ? result.map((item) => ({ ...projectRecord(item), proposal: id }))
        : { ...projectRecord(result), proposal: id }) as Json;
      if (new TextEncoder().encode(JSON.stringify(resolved)).length > 40 * 1024) {
        throw new Error("Resolved project result exceeds 40 KiB; narrow the operation");
      }
      this.#proposals.set(id, proposal);
      return resolved;
    }
    return result;
  }
  async apply(
    host: ModuleHost,
    id: string,
    access: LanguageProjectAccess,
    signal: AbortSignal,
    location?: { path: string; from: number; to: number },
  ) {
    const p = this.#proposals.get(id);
    if (!p || p.expires < Date.now()) throw new Error("Language proposal expired; request it again");
    const current = host.languageProvider(p.path);
    if (!current?.allowed || current.registration !== p.registration) {
      throw new Error("Language provider changed; request the operation again");
    }
    if (location) {
      if (!p.locations?.some((l) => l.path === location.path &&
        l.from === location.from && l.to === location.to)) {
        throw new Error("Location does not belong to this language proposal");
      }
    } else if (!p.edit) throw new Error("Not a workspace edit proposal");
    await this.#current(p.context, access, signal);
    const snapshots = await this.#snapshots(p.reads, access);
    await this.#current(p.context, access, signal);
    const active = host.languageProvider(p.path);
    if (!active?.allowed || active.registration !== p.registration) {
      throw new Error("Language provider changed; request the operation again");
    }
    const edit = location
      ? { documents: [{ ...projectDocument(snapshots.get(location.path)), edits: [] }] }
      : p.edit;
    if (!edit) throw new Error("Missing project edit");
    const result = await access.commit(
      p.context.revision, edit,
      [...snapshots.values()],
      location,
    );
    this.#proposals.delete(id);
    return result;
  }
}
