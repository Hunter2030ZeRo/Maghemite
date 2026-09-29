import { INSTALLATION_TRANSFER } from "../shared/installation_transport.ts";
import { MAX_FRAME } from "../modules/runtimes/protocol.ts";

/** One acknowledged fragment at a time; no large burst bypasses backpressure. */
export class InstallationTransfers {
  #sequence = 0;
  readonly #pending = new Map<number, { transfer: number; text: string; offset: number }>();
  constructor(readonly send: (message: unknown) => void) {}
  begin(requestId: number, message: unknown) {
    const text = JSON.stringify(message), bytes = new TextEncoder().encode(text).length;
    if (bytes > INSTALLATION_TRANSFER.bytes) throw new Error("Installation message too large");
    this.#pending.delete(requestId);
    if (bytes < MAX_FRAME) {
      this.send(message);
      return;
    }
    if (this.#pending.size >= INSTALLATION_TRANSFER.pending) {
      throw new Error("Installation transfer queue full");
    }
    const transfer = ++this.#sequence;
    this.#pending.set(requestId, { transfer, text, offset: 0 });
    this.next(requestId, transfer, 0);
  }
  next(requestId: number, transfer: number, offset: number) {
    const pending = this.#pending.get(requestId);
    // A newer pushed snapshot or an aborted request supersedes an old ack.
    if (!pending || pending.transfer !== transfer) return;
    if (offset !== pending.offset) throw new Error("Invalid installation transfer offset");
    const part = pending.text.slice(offset, offset + INSTALLATION_TRANSFER.characters);
    pending.offset += part.length;
    const done = pending.offset === pending.text.length;
    this.send({ type: "installationChunk", requestId, transfer, offset, part, done });
    if (done) this.#pending.delete(requestId);
  }
  cancel(requestId: number) { this.#pending.delete(requestId); }
  clear() { this.#pending.clear(); }
}
