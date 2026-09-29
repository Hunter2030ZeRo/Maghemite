import { ok, strictEqual as eq } from "node:assert/strict";
import { createWorkbenchApplication } from "../src/workspace/application.ts";
import { jsonCopy } from "../../src/modules/runtimes/protocol.ts";
Deno.test("indexed knowledge replies fit SDK frames and retain consistent node references", () => {
  const nodes = Array.from(
    { length: 200 },
    (_, i) => ({
      id: `${i}/${"한글".repeat(300)}.md`,
      path: `${i}/${"한글".repeat(300)}.md`,
    }),
  );
  const edges = nodes.slice(1).map((n) => ({
    source: n.id,
    target: nodes[0].id,
  }));
  const app = createWorkbenchApplication({
    documents: () => [],
    active: () => undefined,
    mode: () => "knowledge",
    edit: () => {},
    open: () => {},
    layout: () => {},
    notify: () => {},
    output: () => {},
    knowledge: () => ({ nodes, edges, truncated: false }),
  });
  const graph = app.invoke("knowledge.graph", {}, "test.large") as unknown as {
    nodes: typeof nodes;
    edges: typeof edges;
    truncated: boolean;
  };
  ok(graph.nodes.length > 0 && graph.nodes.length < nodes.length);
  eq(graph.truncated, true);
  const ids = new Set(graph.nodes.map((n) => n.id));
  ok(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
  jsonCopy(graph);
  // Backlink IDs are normally bounded by the SDK request schema; source paths can be much longer.
  const boundedTarget = "target.md";
  const backlinks = createWorkbenchApplication({
    documents: () => [],
    active: () => undefined,
    mode: () => "knowledge",
    edit: () => {},
    open: () => {},
    layout: () => {},
    notify: () => {},
    output: () => {},
    knowledge: () => ({
      nodes,
      edges: edges.map((e) => ({ ...e, target: boundedTarget })),
      truncated: false,
    }),
  }).invoke(
    "knowledge.backlinks",
    { id: boundedTarget },
    "test.large",
  ) as unknown as { sources: string[]; truncated: boolean };
  eq(backlinks.truncated, true);
  ok(backlinks.sources.length > 0);
  jsonCopy(backlinks);
});
