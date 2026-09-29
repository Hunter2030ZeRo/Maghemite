import { AotError } from "../../shared/module_aot.ts";

/** In-process owners complement the caller's exclusive profile/store lock. */
export class GenerationOwners {
  #pins = 0;
  #references = 0;
  #reclaiming = false;

  acquire(kind: "pin" | "reference"): () => void {
    if (this.#reclaiming) throw new AotError("unavailable", "Generation is reclaimed");
    switch (kind) {
      case "pin": this.#pins++; break;
      case "reference": this.#references++; break;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      switch (kind) {
        case "pin": this.#pins--; break;
        case "reference": this.#references--; break;
      }
    };
  }

  beginReclaim(): void {
    if (this.#pins || this.#references) {
      throw new AotError("in-use", "Generation has active pins or installation references");
    }
    if (this.#reclaiming) throw new AotError("unavailable", "Generation is reclaimed");
    this.#reclaiming = true;
  }

  failedReclaim(): void {
    this.#reclaiming = false;
  }
}
