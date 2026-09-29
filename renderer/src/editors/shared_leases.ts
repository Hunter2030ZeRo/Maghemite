export interface LeasePresence {
  isFocused?(): boolean;
  isVisible?(): boolean;
}

export interface SharedLease<Value> {
  readonly value: Value;
  release(): void;
}

export type SharedLeasePoolOptions<Key, Options, Value> = {
  create(key: Key, current: () => Options): Value;
  dispose(value: Value): void;
};

type Entry<Options, Value> = {
  readonly value: Value;
  readonly options: Map<number, Options>;
};

function preferred<Options extends LeasePresence>(
  options: Iterable<Options>,
): Options | undefined {
  const live = [...options];
  return live.find((item) => item.isFocused?.()) ??
    live.find((item) => item.isVisible?.()) ??
    live[0];
}

/** Reference-counted shared values whose callbacks always resolve through a live lease. */
export function createSharedLeasePool<
  Key,
  Options extends LeasePresence,
  Value,
>(
  lifecycle: SharedLeasePoolOptions<Key, Options, Value>,
) {
  const entries = new Map<Key, Entry<Options, Value>>();
  let nextLease = 0;

  return {
    acquire(key: Key, options: Options): SharedLease<Value> {
      const id = nextLease++;
      let entry = entries.get(key);
      if (entry) {
        entry.options.set(id, options);
      } else {
        const live = new Map([[id, options]]);
        const current = () => {
          const selected = preferred(live.values());
          if (!selected) {
            throw new Error("Shared value has no live lease");
          }
          return selected;
        };
        entry = { value: lifecycle.create(key, current), options: live };
        entries.set(key, entry);
      }

      let active = true;
      return {
        value: entry.value,
        release() {
          if (!active) return;
          active = false;
          if (entry.options.size === 1) {
            lifecycle.dispose(entry.value);
            entries.delete(key);
          } else {
            entry.options.delete(id);
          }
        },
      };
    },
  };
}
