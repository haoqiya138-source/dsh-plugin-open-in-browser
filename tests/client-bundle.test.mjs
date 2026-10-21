/**
 * Contract tests for the built browser artifact (`dist/client.js`).
 *
 * The bundle is executed in a bare VM context that only provides `window` (with the
 * DSH module loader), `require` (for `react`), and optionally `fetch` — the same
 * surface DSH gives a client plugin. The tests then drive the registered `inject()`
 * closures against a stub Host route and a stub Remote, so both open paths, the
 * safety gate, and the three slot registrations are covered without rendering React.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const bundleSource = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const INSIDE = 'C:\\Users\\me\\project\\pages\\preview.html'
const ADDRESS = 'dsh-resource://file/session/sess-1/pages/preview.html'
const OPEN_ROUTE_PATH = '/dsh-plugin-open-in-browser/open'

/** Cross-realm objects created inside the VM context are normalized before comparing. */
const toPlain = (value) => JSON.parse(JSON.stringify(value))

/** Minimal React stand-in: the factory only needs `createElement` at load time. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

/** Execute the bundle and return the module descriptor it registers. */
function loadModule({ fetch } = {}) {
  let descriptor
  const window = {
    __ModuleLoader__: {
      load: (module) => {
        descriptor = module
      },
    },
  }
  const context = vm.createContext({
    window,
    console,
    require: (specifier) => {
      assert.equal(specifier, 'react', `the client bundle must only require react, got ${specifier}`)
      return fakeReact
    },
    ...(fetch === undefined ? {} : { fetch }),
  })
  vm.runInContext(bundleSource, context, { filename: 'client.js' })
  assert.ok(descriptor !== undefined, 'bundle did not call window.__ModuleLoader__.load')
  return descriptor
}

/**
 * Build a fake Cordis client context, its Remote stub, and its Host-route stub.
 *
 * `routeReply`:
 * - an object → the route answers HTTP 200 with `{ ok: true, ...routeReply }`
 * - `false` → the route answers HTTP 500
 * - omitted → the route answers HTTP 200 with `{ ok: true, mode: 'browser' }`
 * - `undefined` (present but undefined) → no `fetch` exists in the page at all
 */
function harness(options = {}) {
  const { canOpen = true, reply = { ok: true }, remote = true } = options
  const routeReply = 'routeReply' in options ? options.routeReply : { mode: 'browser' }
  const calls = []
  const requests = []
  const registrations = []
  const session = {
    canOpenWorkspacePath: async () => ({ ok: true, value: canOpen }),
    openWorkspacePath: async (request) => {
      calls.push(request)
      return reply
    },
  }
  const ctx = {
    slots: {
      inject: (slot, register) => {
        register()
        return { slot }
      },
      register: (options, component) => {
        registrations.push({ slot: options.name, options, component })
        return { options }
      },
    },
    effect: (register) => register(),
    get: (service) => {
      if (service !== 'remote') return undefined
      return remote ? { session } : undefined
    },
  }
  const fetch =
    routeReply === undefined
      ? undefined
      : async (url, init = {}) => {
          requests.push({ url, method: init.method, headers: init.headers, body: init.body })
          if (routeReply === false) {
            return { ok: false, status: 500, json: async () => ({}) }
          }
          return { ok: true, status: 200, json: async () => ({ ok: true, ...routeReply }) }
        }
  return { ctx, calls, requests, registrations, fetch }
}

/** Load, apply, and return the injected closures for every seat. */
function mount(options) {
  const built = harness(options)
  const module = loadModule({ fetch: built.fetch })
  const client = module.factory(() => fakeReact)
  client.apply(built.ctx)
  const bySlot = Object.fromEntries(built.registrations.map((entry) => [entry.slot, entry]))
  return {
    ...built,
    bySlot,
    documentInjected: bySlot['sidebar.right.tab.document.actions'].options.inject(),
    menuInjected: bySlot['sidebar.right.tab.menu.item'].options.inject(),
  }
}

test('bundle registers itself under the package name', () => {
  const module = loadModule()
  assert.equal(module.id, packageJson.name)
  assert.equal(module.id, 'dsh-plugin-open-in-browser')
  assert.equal(typeof module.factory, 'function')
})

test('factory returns the inject list and apply entry', () => {
  const module = loadModule()
  const client = module.factory((specifier) => {
    assert.equal(specifier, 'react')
    return fakeReact
  })
  assert.equal(typeof client.apply, 'function')
  assert.ok(Array.isArray(client.inject))
  for (const service of ['slots', 'locale', 'remote', 'remote.session']) {
    assert.ok(client.inject.includes(service), `inject must list ${service}`)
  }
})

test('apply mounts the two document seats plus the tab-menu seat', () => {
  const { registrations } = mount()

  assert.deepEqual(
    registrations.map((entry) => entry.slot),
    [
      'sidebar.right.tab.document.actions',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.right.tab.menu.item',
    ],
  )
  for (const entry of registrations) {
    assert.equal(entry.options.id, 'dsh-plugin-open-in-browser')
    assert.equal(entry.options.locale, 'open-in-browser')
    assert.equal(typeof entry.options.inject, 'function')
    assert.equal(typeof entry.component, 'function')
  }
})

test('inject closures expose the caller each seat needs', () => {
  const { documentInjected, menuInjected } = mount()

  assert.equal(typeof documentInjected.openInBrowser, 'function')
  assert.equal(typeof documentInjected.probeDesktop, 'function')
  assert.equal(typeof menuInjected.openAddress, 'function')
})

test('opens an allowed file through the Host route first', async () => {
  const { documentInjected, requests, calls } = mount()

  const outcome = await documentInjected.openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: true, mode: 'browser' })
  assert.equal(calls.length, 0)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, OPEN_ROUTE_PATH)
  assert.equal(requests[0].method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].body), { path: INSIDE })
})

test('falls back to the Host Remote when the route is absent', async () => {
  const { documentInjected, requests, calls } = mount({ routeReply: undefined })

  const outcome = await documentInjected.openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: true, mode: 'association' })
  assert.equal(requests.length, 0)
  assert.deepEqual(toPlain(calls), [{ path: INSIDE }])
})

test('falls back to the Host Remote when the route answers an error', async () => {
  const { documentInjected, calls } = mount({ routeReply: false })

  const outcome = await documentInjected.openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: true, mode: 'association' })
  assert.equal(calls.length, 1)
})

test('refuses a traversal path before touching the route or the Remote', async () => {
  const { documentInjected, requests, calls } = mount()

  const outcome = await documentInjected.openInBrowser('C:\\Users\\me\\project\\..\\secret.html')

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'traversal' })
  assert.equal(requests.length, 0)
  assert.equal(calls.length, 0)
})

test('refuses a non-whitelisted extension before touching the route or the Remote', async () => {
  const { documentInjected, requests, calls } = mount()

  const outcome = await documentInjected.openInBrowser('C:\\Users\\me\\project\\tool.exe')

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'extension' })
  assert.equal(requests.length, 0)
  assert.equal(calls.length, 0)
})

test('reports unavailable when neither the route nor a desktop Remote exists', async () => {
  const { documentInjected, calls } = mount({ routeReply: undefined, canOpen: false })

  const outcome = await documentInjected.openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'unavailable' })
  assert.equal(calls.length, 0)
})

test('reports unavailable when no Remote is composed and the route is absent', async () => {
  const { documentInjected } = mount({ routeReply: undefined, remote: false })

  assert.equal(await documentInjected.probeDesktop(), false)
  assert.deepEqual(toPlain(await documentInjected.openInBrowser(INSIDE)), { ok: false, code: 'unavailable' })
})

test('reports remote-refused when the Host declines the association', async () => {
  const { documentInjected, calls } = mount({ routeReply: undefined, reply: { ok: false } })

  const outcome = await documentInjected.openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'remote-refused' })
  assert.equal(calls.length, 1)
})

test('opens a tab by its resource address through the Host route', async () => {
  const { menuInjected, requests } = mount()

  const outcome = await menuInjected.openAddress(ADDRESS)

  assert.deepEqual(toPlain(outcome), { ok: true, mode: 'browser' })
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(requests[0].body), { address: ADDRESS })
})

test('refuses a tab address that is not a DSH file address', async () => {
  const { menuInjected, requests } = mount()

  const outcome = await menuInjected.openAddress('https://example.com/a.html')

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'bad-address' })
  assert.equal(requests.length, 0)
})

test('reports route-refused when a tab has no Host route to call', async () => {
  const { menuInjected } = mount({ routeReply: undefined })

  assert.deepEqual(toPlain(await menuInjected.openAddress(ADDRESS)), { ok: false, code: 'route-refused' })
})

test('probes the Host once per page', async () => {
  const { ctx, registrations } = harness({ routeReply: undefined })
  const original = ctx.get
  let probes = 0
  ctx.get = (service) => {
    const value = original(service)
    if (service === 'remote' && value !== undefined) {
      const session = value.session
      return {
        session: {
          ...session,
          canOpenWorkspacePath: async () => {
            probes += 1
            return { ok: true, value: true }
          },
        },
      }
    }
    return value
  }
  const module = loadModule()
  module.factory(() => fakeReact).apply(ctx)

  const injected = registrations[0].options.inject()
  await injected.probeDesktop()
  await injected.openInBrowser(INSIDE)
  await injected.openInBrowser(INSIDE)

  assert.equal(probes, 1)
})

/** Collect every string rendered inside a fake React element tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

test('header control renders bundled text when the locale service has no entry', () => {
  const { bySlot, documentInjected } = mount()

  const tree = bySlot['sidebar.right.tab.document.actions'].component({
    absolutePath: INSIDE,
    ...documentInjected,
    // A locale service with no strings for this namespace returns the key itself.
    t: (key) => key,
  })

  const rendered = textOf(tree)
  assert.match(rendered, /Open in browser/)
  assert.doesNotMatch(rendered, /action\.label/)
})

test('header control renders nothing without a Host path', () => {
  const { bySlot, documentInjected } = mount()

  const tree = bySlot['sidebar.right.tab.document.actions'].component({
    ...documentInjected,
    t: (key) => key,
  })

  assert.equal(tree, null)
})

test('empty control offers the browser action for an unpreviewable file', () => {
  const { bySlot, documentInjected } = mount()

  const tree = bySlot['sidebar.right.tab.document.unpreviewable'].component({
    absolutePath: INSIDE,
    ...documentInjected,
    t: (key) => key,
  })

  const rendered = textOf(tree)
  assert.match(rendered, /cannot be previewed/)
  assert.match(rendered, /Open in browser/)
})

test('tab menu renders nothing when the tab does not point at a local file', () => {
  const { bySlot, menuInjected } = mount()

  const tree = bySlot['sidebar.right.tab.menu.item'].component({
    tab: { contentId: 'agent/42' },
    ...menuInjected,
    t: (key) => key,
  })

  assert.equal(tree, null)
})

test('tab menu offers the browser action for a file tab and opens its address', async () => {
  const { bySlot, menuInjected, requests } = mount()
  let dismissed = false

  const tree = bySlot['sidebar.right.tab.menu.item'].component({
    tab: { contentId: ADDRESS },
    ...menuInjected,
    dismiss: () => {
      dismissed = true
    },
    t: (key) => key,
  })

  assert.match(textOf(tree), /Open in browser/)
  tree.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(requests[0].body), { address: ADDRESS })
  assert.equal(dismissed, true)
})
