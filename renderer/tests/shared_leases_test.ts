import { strictEqual as eq } from "node:assert/strict";
import { createSharedLeasePool } from "../src/editors/shared_leases.ts";

type View = {
  focused: boolean;
  visible: boolean;
  calls: number;
  isFocused(): boolean;
  isVisible(): boolean;
};

function view(visible: boolean): View {
  return {
    focused: false,
    visible,
    calls: 0,
    isFocused() {
      return this.focused;
    },
    isVisible() {
      return this.visible;
    },
  };
}

Deno.test("shared leases route through the focused live view and dispose after the last release", () => {
  // Given two views of one shared document.
  const disposed: number[] = [];
  let created = 0;
  const pool = createSharedLeasePool<string, View, { forward(): void }>({
    create(_key, current) {
      created++;
      return { forward: () => current().calls++ };
    },
    dispose() {
      disposed.push(created);
    },
  });
  const hidden = view(false);
  const visible = view(true);
  const first = pool.acquire("document", hidden);
  const second = pool.acquire("document", visible);

  // When callbacks run before and after focus and lease changes.
  first.value.forward();
  hidden.focused = true;
  second.value.forward();
  first.release();
  second.value.forward();

  // Then one value survives the first release and never routes to that closed view.
  eq(first.value, second.value);
  eq(created, 1);
  eq(hidden.calls, 1);
  eq(visible.calls, 2);
  eq(disposed.length, 0);
  second.release();
  eq(disposed.length, 1);
});

Deno.test("shared lease release is idempotent and reacquisition creates a fresh lifetime", () => {
  // Given one shared document lifetime.
  let created = 0;
  let disposed = 0;
  const pool = createSharedLeasePool<string, View, { generation: number }>({
    create() {
      return { generation: ++created };
    },
    dispose() {
      disposed++;
    },
  });
  const first = pool.acquire("document", view(true));

  // When its lease closes twice and the document is acquired again.
  first.release();
  first.release();
  const second = pool.acquire("document", view(true));

  // Then disposal occurred once and the new lease owns a fresh value.
  eq(disposed, 1);
  eq(first.value.generation, 1);
  eq(second.value.generation, 2);
  second.release();
  eq(disposed, 2);
});
