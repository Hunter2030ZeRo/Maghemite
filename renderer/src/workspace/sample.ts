import { documentFromText } from './model'

/** Deliberate sample data, not a representation of the user's filesystem. */
export const sampleDocuments = () => [
  documentFromText(
    'notes/Workspace.md',
    `# A place for code and ideas

Some thoughts become code. Some code becomes a new thought. Keep both in the same workspace, with room to follow the connection.

## One workspace, two perspectives

Use **Develop** to explore the project. Switch to **Knowledge** to follow your notes. Your tabs, drafts, and place in the document stay with you.

The layout stays familiar: navigation on the left, your work in the center, context on the right.

## A few things to try

- Open src/main.ts alongside this note.
- Follow [[Architecture]] to explore how the pieces fit together.
- Write something down in [[Module ideas]].
- Press Ctrl+K to find a file or run a command.

## Leave room for connections

A note does not need to be finished to be useful. Link it to another idea, keep a question open, and come back when the code tells you something new.

> This is a sample workspace. Edits are kept in this browser; source files on disk are not changed.
`,
  ),
  documentFromText(
    'notes/Architecture.md',
    `# Architecture

The workspace in [[Workspace]] brings documents and tools together without tying them to one rendering mode.

## Shared document model

Code and Markdown both have a stable identity, content, and a saved draft. Tabs refer to documents; they do not own a second copy.

## Boundaries

- Solid owns the workspace interface.
- Deno owns desktop services and permissions.
- Rust owns indexing and native integrations.
- Modules contribute through a shared SDK.

## Next connections

Bring [[Module ideas]] into the command palette when the desktop bridge is ready.
`,
  ),
  documentFromText(
    'notes/Module ideas.md',
    `# Module ideas

A small collection of possibilities for this [[Workspace]].

## Daily notes

Create a dated note and link it to the current project.

## Source to knowledge

Collect symbol references and connect them to design decisions in [[Architecture]].

## Reading queue

Keep useful links beside the code that made them relevant.
`,
  ),
  documentFromText(
    'src/main.ts',
    `// Sample workspace entry point\nimport { createWorkspace } from './workspace.ts'\n\nconst workspace = createWorkspace({\n  name: 'Maghemite',\n  perspective: 'develop',\n})\n\n// Code and notes belong to the same workspace.\nworkspace.open('notes/Workspace.md')\nworkspace.open('src/main.ts')\n\nexport default workspace\n`,
  ),
  documentFromText(
    'src/workspace.ts',
    `export type Perspective = 'develop' | 'knowledge'\n\ninterface WorkspaceOptions {\n  name: string\n  perspective: Perspective\n}\n\nexport function createWorkspace(options: WorkspaceOptions) {\n  const documents = new Set<string>()\n\n  return {\n    ...options,\n    open(path: string) {\n      documents.add(path)\n    },\n    documents,\n  }\n}\n`,
  ),
  documentFromText(
    'deno.json',
    '{\n  "name": "maghemite-sample",\n  "version": "0.1.0",\n  "description": "A sample workspace for code and notes"\n}\n',
  ),
  documentFromText(
    'README.md',
    '# Maghemite\n\nA workspace for code, notes, and the connections between them.\n\nStart with [[Workspace]], explore [[Architecture]], or collect [[Module ideas]].\n',
  ),
]
