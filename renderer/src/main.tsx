import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { applyTheme, readPreferredTheme } from './themes/apply'
import { getTheme } from './themes/registry'

const initialThemeId = readPreferredTheme()
applyTheme(getTheme(initialThemeId), document.documentElement)

render(
  () => <App initialThemeId={initialThemeId} />,
  document.getElementById('root')!,
)
