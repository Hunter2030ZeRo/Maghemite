import { createMemo, For, Show } from "solid-js";
import type { Workspace } from "../workspace/store";
import { stem } from "../workspace/model";
import { Icon } from "../components/Icon";

export function Graph(props: { workspace: Workspace }) {
  const notes = createMemo(() =>
    props.workspace.knowledge.notes().slice(0, 200)
  );
  const edges = createMemo(() =>
    props.workspace.knowledge.edges().filter((edge) =>
      notes().some((n) => n.id === edge.source) &&
      notes().some((n) => n.id === edge.target)
    )
  );
  const nodes = createMemo(() =>
    notes().map((doc, i, all) => ({
      doc,
      x: 360 + Math.cos(i * Math.PI * 2 / all.length - Math.PI / 2) * 205,
      y: 255 + Math.sin(i * Math.PI * 2 / all.length - Math.PI / 2) * 150,
    }))
  );
  return (
    <section class="graph-surface" aria-label="Knowledge graph">
      <div class="graph-heading">
        <div>
          <span class="eyebrow">THE CONNECTIONS BETWEEN</span>
          <h1>Your notes</h1>
        </div>
        <span class="muted">
          {notes().length} notes · {edges().length} links
        </span>
      </div>
      <Show
        when={notes().length}
        fallback={<p class="empty-copy">Create a note to start a graph.</p>}
      >
        <svg
          viewBox="0 0 720 510"
          role="img"
          aria-label="Links between notes. Use the note buttons below to open a document."
        >
          <For each={edges()}>
            {(edge) => {
              const from = () => nodes().find((n) => n.doc.id === edge.source),
                to = () => nodes().find((n) => n.doc.id === edge.target);
              return (
                <Show when={from() && to()}>
                  <line
                    x1={from()?.x}
                    y1={from()?.y}
                    x2={to()?.x}
                    y2={to()?.y}
                    class="graph-edge"
                  />
                </Show>
              );
            }}
          </For>
          <For each={nodes()}>
            {(node) => (
              <g
                class="graph-node"
                onClick={() => props.workspace.openFile(node.doc.id)}
              >
                <circle cx={node.x} cy={node.y} r="24" class="graph-halo" />
                <circle cx={node.x} cy={node.y} r="7" />
                <text x={node.x} y={node.y + 45} text-anchor="middle">
                  {stem(node.doc.path)}
                </text>
              </g>
            )}
          </For>
        </svg>
        <div class="graph-note-list">
          <For each={notes()}>
            {(doc) => (
              <button onClick={() => props.workspace.openFile(doc.id)}>
                <Icon name="notes" />
                {stem(doc.path)}
                <Icon name="arrow" />
              </button>
            )}
          </For>
        </div>
      </Show>
      <p class="graph-caption">
        {props.workspace.knowledge.status()} · Showing {notes().length} of{" "}
        {props.workspace.knowledge.notes().length}{" "}
        notes. Add a [[note link]] to connect ideas.
      </p>
    </section>
  );
}
