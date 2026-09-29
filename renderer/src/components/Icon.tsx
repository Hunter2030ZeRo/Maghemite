import type { JSX } from 'solid-js'

const paths = {
  settings: "M3 5h14M3 10h14M3 15h14M7 2v6M13 7v6M7 12v6",
  refresh: "M17 8a7 7 0 1 0 0 5M17 3v5h-5",
  files: 'M7 3H3v14h10v-4M7 1h7l4 4v12H7zM14 1v5h4',
  search: 'M14 14l4 4M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3',
  notes: 'M4 2h12v16H4zM7 6h6M7 10h6M7 14h3',
  graph:
    'M5 6l9-2M5 6l5 10M14 4l-4 12M3 6a2 2 0 1 0 4 0 2 2 0 0 0-4 0M12 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0M8 16a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
  modules: 'M2 2h6v6H2zM12 2h6v6h-6zM2 12h6v6H2zM12 12h6v6h-6z',
  left: 'M2 3h16v14H2zM7 3v14',
  right: 'M2 3h16v14H2zM13 3v14',
  bottom: 'M2 3h16v14H2zM2 12h16',
  close: 'M5 5l10 10M15 5L5 15',
  chevron: 'M7 4l6 6-6 6',
  plus: 'M10 3v14M3 10h14',
  code: 'M6 5l-4 5 4 5M14 5l4 5-4 5M12 2L8 18',
  terminal: 'M3 4l6 6-6 6M11 16h6',
  command:
    'M7 7h6v6H7zM7 7H4a3 3 0 1 1 3-3zM13 7V4a3 3 0 1 1 3 3zM13 13h3a3 3 0 1 1-3 3zM7 13v3a3 3 0 1 1-3-3z',
  check: 'M3 10l5 5L17 5',
  folder: 'M2 5V3h6l2 3h8v11H2z',
  save: 'M3 2h12l3 3v13H2V2zM6 2v6h8V2M6 18v-6h8v6',
  link:
    'M8 12l4-4M6 14l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M11 13a3 3 0 0 0 4 0l4-4a3 3 0 0 0-4-4l-1 1',
  download: 'M10 2v11M6 9l4 4 4-4M3 14v4h14v-4',
  book: 'M10 5C7 2 4 2 2 3v13c3-1 5-1 8 2 3-3 5-3 8-2V3c-2-1-5-1-8 2v13',
  sun:
    'M10 1v2M10 17v2M1 10h2M17 10h2M4 4l1 1M15 15l1 1M4 16l1-1M15 5l1-1M6 10a4 4 0 1 0 8 0 4 4 0 0 0-8 0',
  dots: 'M3 10h1M9 10h1M15 10h1',
  arrow: 'M3 10h14M12 5l5 5-5 5',
}
export type IconName = keyof typeof paths
export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg
      class={`icon ${props.class ?? ''}`}
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      stroke-width='1.5'
      stroke-linecap='round'
      stroke-linejoin='round'
      aria-hidden='true'
    >
      <path d={paths[props.name]} />
    </svg>
  )
}
export function IconButton(
  props: {
    name: IconName
    label: string
    onClick: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
    active?: boolean
    disabled?: boolean
  },
) {
  return (
    <button
      type='button'
      class='icon-button'
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.name} />
    </button>
  )
}
