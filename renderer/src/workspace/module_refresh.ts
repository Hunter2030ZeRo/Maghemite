/** Coalesce exposure during an in-flight list into a subsequent fresh read. */
export function createModuleRefresh(load: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let requested = false;
  return function refresh(): Promise<void> {
    requested = true;
    if (running) return running;
    const work = (async () => {
      do {
        requested = false;
        await load();
      } while (requested);
    })();
    running = work;
    return work.finally(() => { if (running === work) running = undefined; });
  };
}
