import { onCleanup } from 'solid-js'

export function ResizeHandle(
  props: {
    label: string
    orientation: 'vertical' | 'horizontal'
    value: number
    min: number
    max: number
    reverse?: boolean
    onChange: (value: number) => void
  },
) {
  let clean = () => {}
  onCleanup(() => clean())
  const update = (value: number) =>
    props.onChange(Math.max(props.min, Math.min(props.max, value)))
  return (
    <div
      class={`resize-handle ${props.orientation}`}
      role='separator'
      tabindex='0'
      aria-label={props.label}
      aria-orientation={props.orientation}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        clean()
        const horizontal = props.orientation === 'vertical'
        const start = horizontal ? event.clientX : event.clientY,
          value = props.value
        const move = (e: PointerEvent) =>
          update(
            value +
              ((horizontal ? e.clientX : e.clientY) - start) *
                (props.reverse ? -1 : 1),
          )
        clean = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', clean)
          window.removeEventListener('pointercancel', clean)
          document.body.classList.remove('resizing')
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', clean)
        window.addEventListener('pointercancel', clean)
        document.body.classList.add('resizing')
      }}
      onKeyDown={(event) => {
        const keys = props.orientation === 'vertical'
          ? ['ArrowLeft', 'ArrowRight']
          : ['ArrowUp', 'ArrowDown']
        if (!keys.includes(event.key)) return
        event.preventDefault()
        update(
          props.value +
            (event.key === keys[1] ? 16 : -16) * (props.reverse ? -1 : 1),
        )
      }}
    />
  )
}
