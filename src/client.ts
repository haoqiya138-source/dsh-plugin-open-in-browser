/**
 * Browser half of `dsh-plugin-open-in-browser`.
 *
 * Compiled to a bare module body by `scripts/build-client.mjs` and wrapped in the
 * DSH `window.__ModuleLoader__` factory, so this file must stay free of runtime
 * imports except `react` (provided by the browser module table through the
 * wrapper's `require`).
 *
 * What it does: adds an "open in browser" control to two document-preview seats,
 * both of which receive the previewed file's Host (absolute) path as a prop —
 * `sidebar.right.tab.document.actions` (header toolbar) and
 * `sidebar.right.tab.document.unpreviewable` (the empty state shown instead of a
 * body when the preview cannot render the file).
 *
 * Opening itself is NOT done here: the browser half calls the Host Remote
 * `session.openWorkspacePath({ path })`, which re-verifies the Host path mapping
 * and then launches the OS-default association (for `.html` that is the default
 * browser). The plugin never touches Electron and needs no main-process bridge.
 */

import { validateLocalFileTarget } from './security.js'

/** Package id: must equal the package name and the loader factory id. */
export const PLUGIN_ID = 'dsh-plugin-open-in-browser'

/** Locale namespace: matches `locale/*.json` and the `locale` registration option. */
export const LOCALE_NAMESPACE = 'open-in-browser'

/** Slots this plugin contributes to. */
export const DOCUMENT_ACTIONS_SLOT = 'sidebar.right.tab.document.actions'
export const DOCUMENT_UNPREVIEWABLE_SLOT = 'sidebar.right.tab.document.unpreviewable'

/** Services the browser half needs. Declared at module level so Cordis resolves them. */
export const inject = ['slots', 'locale', 'remote', 'remote.session'] as const

/** Minimal structural React surface available from the browser module table. */
interface ReactLike {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  useState: <State>(initial: State | (() => State)) => readonly [State, (next: State | ((previous: State) => State)) => void]
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
}

// Provided by the loader wrapper (`const React = require('react')`).
declare const React: ReactLike

/** Host Remote reply envelope used by DSH Remotes. */
interface RemoteReply<Value> {
  readonly ok: boolean
  readonly value?: Value
}

/** The slice of `remote.session` this plugin uses. */
interface SessionRemoteLike {
  canOpenWorkspacePath(): Promise<RemoteReply<boolean>>
  openWorkspacePath(request: { path: string; action?: 'reveal'; application?: string }): Promise<RemoteReply<unknown>>
}

/** The slice of the Cordis client context this plugin uses. */
interface ClientContextLike {
  readonly slots: {
    inject: (slot: string, register: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  readonly effect?: (register: () => unknown) => unknown
  get: (service: string) => unknown
}

/** Props handed to a slot component by its owner plus this plugin's `inject` closure. */
interface SlotProps {
  readonly [key: string]: unknown
}

/** Translation function shape exposed by the locale service. */
type Translate = (key: string, named?: Record<string, unknown>) => string

/** Why an open attempt failed, plus the local validation codes from `security.ts`. */
type OpenFailureCode =
  | 'unavailable'
  | 'remote-refused'
  | 'empty'
  | 'control-chars'
  | 'too-long'
  | 'not-absolute'
  | 'unc-path'
  | 'device-path'
  | 'traversal'
  | 'extension'
  | 'outside-root'
  | 'realpath-failed'
  | 'symlink-escape'

/** Result of one click. */
type OpenOutcome = { readonly ok: true } | { readonly ok: false; readonly code: OpenFailureCode }

/** English fallback so the control never renders a raw locale key. */
const FALLBACK_EN: Readonly<Record<string, string>> = Object.freeze({
  'action.label': 'Open in browser',
  'action.title': 'Open in the system default browser',
  'action.opened': 'Opened',
  'empty.hint': 'This file cannot be previewed here. Open it in the system browser instead.',
  'error.unavailable': 'This deployment has no native desktop available.',
  'error.remote-refused': 'The Host refused to open this path.',
  'error.empty': 'No file was selected.',
  'error.control-chars': 'The path contains control characters.',
  'error.too-long': 'The path is too long.',
  'error.not-absolute': 'The path is not absolute.',
  'error.unc-path': 'Network share paths are not opened.',
  'error.device-path': 'Device paths are not opened.',
  'error.traversal': 'The path contains a traversal segment.',
  'error.extension': 'This file type is not opened in a browser.',
  'error.outside-root': 'The file is outside the workspace.',
  'error.realpath-failed': 'The file could not be resolved.',
  'error.symlink-escape': 'The file resolves outside the workspace.',
})

/** Chinese fallback, used when the browser UI itself is Chinese. */
const FALLBACK_ZH: Readonly<Record<string, string>> = Object.freeze({
  'action.label': '在浏览器打开',
  'action.title': '用系统默认浏览器打开',
  'action.opened': '已打开',
  'empty.hint': '这里无法预览该文件，可以改用系统浏览器打开。',
  'error.unavailable': '当前部署没有可用的本机桌面。',
  'error.remote-refused': 'Host 拒绝打开该路径。',
  'error.empty': '没有选中文件。',
  'error.control-chars': '路径包含控制字符。',
  'error.too-long': '路径过长。',
  'error.not-absolute': '路径不是绝对路径。',
  'error.unc-path': '不打开网络共享路径。',
  'error.device-path': '不打开设备路径。',
  'error.traversal': '路径包含向上跳转的片段。',
  'error.extension': '该文件类型不在浏览器打开白名单内。',
  'error.outside-root': '该文件不在工作区内。',
  'error.realpath-failed': '无法解析该文件。',
  'error.symlink-escape': '该文件解析后位于工作区之外。',
})

const BUTTON_STYLE: Readonly<Record<string, string | number>> = Object.freeze({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  height: '24px',
  padding: '0 6px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))',
  background: 'transparent',
  color: 'var(--dsw-alias-text-primary, currentColor)',
  font: 'inherit',
  fontSize: '12px',
  lineHeight: '1',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

const STATUS_STYLE: Readonly<Record<string, string | number>> = Object.freeze({
  ...BUTTON_STYLE,
  border: '1px solid transparent',
  cursor: 'default',
  opacity: '0.72',
})

const EMPTY_STATE_STYLE: Readonly<Record<string, string | number>> = Object.freeze({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '8px',
  padding: '16px',
  color: 'var(--dsw-alias-text-secondary, inherit)',
  fontSize: '12px',
})

/**
 * Probe the Host once per page and call the Remote for the actual launch.
 *
 * The Remote is read through `ctx.get` inside a try/catch because Cordis throws
 * when a service outside `inject` is read, and a render must never crash the UI.
 */
class BrowserTargetController {
  private desktop: Promise<boolean> | undefined
  private readonly remote: SessionRemoteLike | undefined

  constructor(context: ClientContextLike) {
    this.remote = readSessionRemote(context)
  }

  /** Resolve once whether this deployment can hand a path to a native desktop. */
  probe(): Promise<boolean> {
    if (this.desktop === undefined) {
      this.desktop = (async () => {
        const remote = this.remote
        if (remote === undefined) return false
        try {
          const reply = await remote.canOpenWorkspacePath()
          return reply.ok === true && reply.value === true
        } catch {
          return false
        }
      })()
    }
    return this.desktop
  }

  /** Validate, then ask the Host to open the path with its default application. */
  async open(rawPath: string): Promise<OpenOutcome> {
    const checked = validateLocalFileTarget({ path: rawPath })
    if (!checked.ok) return { ok: false, code: checked.code }

    const remote = this.remote
    if (remote === undefined) return { ok: false, code: 'unavailable' }
    if ((await this.probe()) === false) return { ok: false, code: 'unavailable' }

    try {
      const reply = await remote.openWorkspacePath({ path: checked.path })
      if (reply.ok !== true) return { ok: false, code: 'remote-refused' }
      return { ok: true }
    } catch {
      return { ok: false, code: 'remote-refused' }
    }
  }
}

/** Read `remote.session` without throwing when the deployment has no Remote. */
function readSessionRemote(context: ClientContextLike): SessionRemoteLike | undefined {
  try {
    const remote = context.get('remote')
    if (typeof remote !== 'object' || remote === null) return undefined
    const session = (remote as { session?: unknown }).session
    if (typeof session !== 'object' || session === null) return undefined
    const candidate = session as { canOpenWorkspacePath?: unknown; openWorkspacePath?: unknown }
    if (typeof candidate.canOpenWorkspacePath !== 'function') return undefined
    if (typeof candidate.openWorkspacePath !== 'function') return undefined
    return session as SessionRemoteLike
  } catch {
    return undefined
  }
}

/** Whether the browser UI is Chinese, so bundled fallbacks match it. */
function prefersChinese(): boolean {
  try {
    const language = globalThis.navigator?.language
    return typeof language === 'string' && language.toLowerCase().startsWith('zh')
  } catch {
    return false
  }
}

/** Bundled text for a locale key, so an unresolved key never reaches the UI. */
function fallbackText(key: string): string {
  const table = prefersChinese() ? FALLBACK_ZH : FALLBACK_EN
  return table[key] ?? FALLBACK_EN[key] ?? key
}

/** Read the previewed file's Host path from the slot owner's props. */
function readAbsolutePath(props: SlotProps): string | undefined {
  const value = props['absolutePath']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the slot's translation function.
 *
 * The locale service only serves namespaces it was given, and this package ships
 * no UI string catalog, so an unresolved key comes back unchanged. Treat that as
 * "no translation" and use the bundled text instead of showing `action.label`.
 */
function readTranslate(props: SlotProps): Translate {
  const candidate = props['t']
  if (typeof candidate !== 'function') {
    return (key: string) => fallbackText(key)
  }
  const translate = candidate as Translate
  return (key: string, named?: Record<string, unknown>): string => {
    let translated: unknown
    try {
      translated = translate(key, named)
    } catch {
      translated = undefined
    }
    if (typeof translated === 'string' && translated.length > 0 && translated !== key) {
      return translated
    }
    return fallbackText(key)
  }
}

/** Read the injected `openInBrowser` function. */
function readOpen(props: SlotProps): ((path: string) => Promise<OpenOutcome>) | undefined {
  const candidate = props['openInBrowser']
  return typeof candidate === 'function' ? (candidate as (path: string) => Promise<OpenOutcome>) : undefined
}

/** Read the injected `probeDesktop` function. */
function readProbe(props: SlotProps): (() => Promise<boolean>) | undefined {
  const candidate = props['probeDesktop']
  return typeof candidate === 'function' ? (candidate as () => Promise<boolean>) : undefined
}

/** The glyph: a window with an outward arrow, inheriting `currentColor`. */
function BrowserIcon(): unknown {
  return React.createElement(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    React.createElement('rect', { x: 1.75, y: 3, width: 12.5, height: 10.5, rx: 2 }),
    React.createElement('path', { d: 'M1.75 6h12.5' }),
    React.createElement('path', { d: 'M5 10.5h3.25' }),
    React.createElement('path', { d: 'M7 9l2.75-2.75' }),
    React.createElement('path', { d: 'M8 6.25h1.75V8' }),
  )
}

/** Header control for `sidebar.right.tab.document.actions`. */
export function OpenInBrowserButton(props: SlotProps): unknown {
  const t = readTranslate(props)
  const absolutePath = readAbsolutePath(props)
  const open = readOpen(props)
  const probe = readProbe(props)
  const [desktop, setDesktop] = React.useState<boolean | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'opening' | 'opened'>('idle')
  const [failure, setFailure] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    let live = true
    if (probe === undefined) {
      setDesktop(false)
      return () => {
        live = false
      }
    }
    void probe().then(
      (available) => {
        if (live) setDesktop(available)
      },
      () => {
        if (live) setDesktop(false)
      },
    )
    return () => {
      live = false
    }
  }, [probe])

  if (absolutePath === undefined || open === undefined) return null
  if (desktop === false) return null

  const onActivate = (): void => {
    if (status === 'opening') return
    setFailure(undefined)
    setStatus('opening')
    void open(absolutePath).then(
      (outcome) => {
        if (outcome.ok) {
          setStatus('opened')
          return
        }
        setStatus('idle')
        setFailure(t(`error.${outcome.code}`))
      },
      () => {
        setStatus('idle')
        setFailure(t('error.remote-refused'))
      },
    )
  }

  if (failure !== undefined) {
    return React.createElement(
      'button',
      {
        type: 'button',
        style: STATUS_STYLE,
        title: failure,
        'aria-label': failure,
        'data-testid': 'open-in-browser-error',
        onClick: () => setFailure(undefined),
      },
      BrowserIcon(),
      React.createElement('span', null, failure),
    )
  }

  return React.createElement(
    'button',
    {
      type: 'button',
      style: BUTTON_STYLE,
      title: t('action.title'),
      'aria-label': t('action.title'),
      'data-testid': 'open-in-browser',
      disabled: status === 'opening',
      onClick: onActivate,
    },
    BrowserIcon(),
    React.createElement('span', null, status === 'opened' ? t('action.opened') : t('action.label')),
  )
}

/** Empty-state control for `sidebar.right.tab.document.unpreviewable`. */
export function OpenInBrowserEmptyState(props: SlotProps): unknown {
  const t = readTranslate(props)
  const absolutePath = readAbsolutePath(props)
  const open = readOpen(props)
  const probe = readProbe(props)
  const [desktop, setDesktop] = React.useState<boolean | null>(null)
  const [failure, setFailure] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    let live = true
    if (probe === undefined) {
      setDesktop(false)
      return () => {
        live = false
      }
    }
    void probe().then(
      (available) => {
        if (live) setDesktop(available)
      },
      () => {
        if (live) setDesktop(false)
      },
    )
    return () => {
      live = false
    }
  }, [probe])

  if (absolutePath === undefined || open === undefined) return null
  if (desktop === false) return null

  const onActivate = (): void => {
    setFailure(undefined)
    void open(absolutePath).then(
      (outcome) => {
        if (!outcome.ok) setFailure(t(`error.${outcome.code}`))
      },
      () => setFailure(t('error.remote-refused')),
    )
  }

  return React.createElement(
    'div',
    { style: EMPTY_STATE_STYLE, 'data-testid': 'open-in-browser-empty' },
    React.createElement('span', null, t('empty.hint')),
    React.createElement(
      'button',
      {
        type: 'button',
        style: BUTTON_STYLE,
        title: t('action.title'),
        onClick: onActivate,
      },
      BrowserIcon(),
      React.createElement('span', null, t('action.label')),
    ),
    failure === undefined ? null : React.createElement('span', { style: { opacity: 0.8 } }, failure),
  )
}

/**
 * Client entry: register both seats once, and clean them up with the plugin.
 */
export function apply(context: ClientContextLike): void {
  const controller = new BrowserTargetController(context)
  const injected = (): Record<string, unknown> => ({
    openInBrowser: (path: string) => controller.open(path),
    probeDesktop: () => controller.probe(),
  })

  const register = (slot: string, component: unknown): void => {
    const options: Record<string, unknown> = {
      name: slot,
      id: PLUGIN_ID,
      order: 20,
      locale: LOCALE_NAMESPACE,
      inject: injected,
    }
    const mount = (): unknown => context.slots.inject(slot, () => context.slots.register(options, component))
    if (typeof context.effect === 'function') {
      context.effect(mount)
      return
    }
    mount()
  }

  register(DOCUMENT_ACTIONS_SLOT, OpenInBrowserButton)
  register(DOCUMENT_UNPREVIEWABLE_SLOT, OpenInBrowserEmptyState)
}
