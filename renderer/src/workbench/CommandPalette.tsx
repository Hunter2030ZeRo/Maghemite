import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { Icon, type IconName } from '../components/Icon'
export interface Command {
  id: string
  label: string
  detail: string
  icon: IconName
  shortcut?: string
  run: () => void
}

export function CommandPalette(
  props: {
    commands: Command[]
    close: () => void
    label?: string
    placeholder?: string
    initialSelectedId?: string
  },
) {
  const [query, setQuery] = createSignal(''),
    [selected, setSelected] = createSignal(0)
  const items = createMemo(() =>
    props.commands.filter((c) =>
      `${c.label} ${c.detail}`.toLowerCase().includes(
        query().trim().toLowerCase(),
      )
    )
  )
  let input!: HTMLInputElement
  const previous = document.activeElement as HTMLElement | null
  onMount(() => {
    const index = props.commands.findIndex((command) =>
      command.id === props.initialSelectedId
    )
    if (index >= 0) setSelected(index)
    input.focus()
  })
  onCleanup(() => {
    if (previous?.isConnected) previous.focus()
  })
  function run(index: number) {
    const command = items()[index]
    if (command) {
      props.close()
      queueMicrotask(command.run)
    }
  }
  return (
    <div
      class='palette-backdrop'
      onClick={(e) => {
        if (e.target === e.currentTarget) props.close()
      }}
    >
      <section
        class='command-palette'
        role='dialog'
        aria-modal='true'
        aria-label={props.label ?? 'Command palette'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.close()
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            input.focus()
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = items().length
            if (n) {
              const next = (selected() + (e.key === 'ArrowDown' ? 1 : -1) + n) %
                n
              setSelected(next)
              document.getElementById(`command-${items()[next].id}`)
                ?.scrollIntoView({ block: 'nearest' })
            }
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            run(selected())
          }
        }}
      >
        <div class='palette-search'>
          <Icon name='search' />
          <input
            ref={(element) => {
              input = element
            }}
            role='combobox'
            aria-label={props.label ?? 'Find a file or command'}
            aria-expanded='true'
            aria-controls='command-results'
            aria-autocomplete='list'
            aria-activedescendant={items()[selected()]
              ? `command-${items()[selected()].id}`
              : undefined}
            placeholder={props.placeholder ?? 'Find a file or run a command…'}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setSelected(0)
            }}
          />
          <button
            onClick={props.close}
            aria-label={props.label
              ? `Close ${props.label}`
              : 'Close command palette'}
          >
            <kbd>esc</kbd>
          </button>
        </div>
        <div
          class='palette-results'
          id='command-results'
          role='listbox'
          aria-label={props.label ?? 'Files and commands'}
        >
          <For each={items()}>
            {(command, index) => (
              <div
                role='option'
                id={`command-${command.id}`}
                aria-selected={selected() === index()}
                class='command-option'
                onMouseMove={() => setSelected(index())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(index())}
              >
                <Icon name={command.icon} />
                <div>
                  <strong>{command.label}</strong>
                  <small>{command.detail}</small>
                </div>
                <Show when={command.shortcut}>
                  <kbd>{command.shortcut}</kbd>
                </Show>
              </div>
            )}
          </For>
          <Show when={!items().length}>
            <p class='empty-copy'>No files or commands match “{query()}”.</p>
          </Show>
        </div>
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>Maghemite</span>
        </footer>
      </section>
    </div>
  )
}
