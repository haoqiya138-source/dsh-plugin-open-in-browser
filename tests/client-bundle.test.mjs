/**
 * Contract tests for the built browser artifact (`dist/client.js`).
 *
 * The bundle is executed in a bare VM context that only provides `window` (with the
 * DSH module loader) and `require` (for `react`), which is the same surface DSH
 * gives a client plugin. The tests then drive the registered `inject()` closure
 * against a stub Remote, so the Remote call shape and the safety gate are covered
 * without rendering React.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const bundleSource = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const INSIDE = 'C:\\Users\\me\\project\\pages\\preview.html'

/** Cross-realm objects created inside the VM context are normalized before comparing. */
const toPlain = (value) => JSON.parse(JSON.stringify(value))

/** Minimal React stand-in: the factory only needs `createElement` at load time. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

/** Execute the bundle and return the module descriptor it registers. */
function loadModule() {
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
  })
  vm.runInContext(bundleSource, context, { filename: 'client.js' })
  assert.ok(descriptor !== undefined, 'bundle did not call window.__ModuleLoader__.load')
  return descriptor
}

/** Build a fake Cordis client context and the Remote stub it should reach. */
function harness({ canOpen = true, reply = { ok: true }, remote = true } = {}) {
  const calls = []
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
  return { ctx, calls, registrations }
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

test('apply mounts both document-preview seats with a stable id and locale', () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, registrations } = harness()

  client.apply(ctx)

  const slots = registrations.map((entry) => entry.slot)
  assert.deepEqual(slots, [
    'sidebar.right.tab.document.actions',
    'sidebar.right.tab.document.unpreviewable',
  ])
  for (const entry of registrations) {
    assert.equal(entry.options.id, 'dsh-plugin-open-in-browser')
    assert.equal(entry.options.locale, 'open-in-browser')
    assert.equal(typeof entry.options.inject, 'function')
    assert.equal(typeof entry.component, 'function')
  }
})

test('inject closure exposes both callables', () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, registrations } = harness()
  client.apply(ctx)

  const injected = registrations[0].options.inject()
  assert.equal(typeof injected.openInBrowser, 'function')
  assert.equal(typeof injected.probeDesktop, 'function')
})

test('opens an allowed file through session.openWorkspacePath', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, calls, registrations } = harness()
  client.apply(ctx)
  const { openInBrowser } = registrations[0].options.inject()

  const outcome = await openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: true })
  assert.deepEqual(toPlain(calls), [{ path: INSIDE }])
})

test('refuses a traversal path before touching the Remote', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, calls, registrations } = harness()
  client.apply(ctx)
  const { openInBrowser } = registrations[0].options.inject()

  const outcome = await openInBrowser('C:\\Users\\me\\project\\..\\secret.html')

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'traversal' })
  assert.equal(calls.length, 0)
})

test('refuses a non-whitelisted extension before touching the Remote', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, calls, registrations } = harness()
  client.apply(ctx)
  const { openInBrowser } = registrations[0].options.inject()

  const outcome = await openInBrowser('C:\\Users\\me\\project\\tool.exe')

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'extension' })
  assert.equal(calls.length, 0)
})

test('reports unavailable when the Host has no desktop', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, calls, registrations } = harness({ canOpen: false })
  client.apply(ctx)
  const { openInBrowser } = registrations[0].options.inject()

  const outcome = await openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'unavailable' })
  assert.equal(calls.length, 0)
})

test('reports unavailable when no Remote is composed', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, registrations } = harness({ remote: false })
  client.apply(ctx)
  const { openInBrowser, probeDesktop } = registrations[0].options.inject()

  assert.equal(await probeDesktop(), false)
  assert.deepEqual(toPlain(await openInBrowser(INSIDE)), { ok: false, code: 'unavailable' })
})

test('reports remote-refused when the Host declines', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, calls, registrations } = harness({ reply: { ok: false } })
  client.apply(ctx)
  const { openInBrowser } = registrations[0].options.inject()

  const outcome = await openInBrowser(INSIDE)

  assert.deepEqual(toPlain(outcome), { ok: false, code: 'remote-refused' })
  assert.equal(calls.length, 1)
})

test('probes the Host once per page', async () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  let probes = 0
  const { ctx, registrations } = harness()
  const original = ctx.get
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
  client.apply(ctx)
  const { openInBrowser, probeDesktop } = registrations[0].options.inject()

  await probeDesktop()
  await openInBrowser(INSIDE)
  await openInBrowser(INSIDE)

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
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, registrations } = harness()
  client.apply(ctx)

  const Button = registrations[0].component
  const tree = Button({
    absolutePath: INSIDE,
    openInBrowser: async () => ({ ok: true }),
    probeDesktop: async () => true,
    // A locale service with no strings for this namespace returns the key itself.
    t: (key) => key,
  })

  const rendered = textOf(tree)
  assert.match(rendered, /Open in browser/)
  assert.doesNotMatch(rendered, /action\.label/)
})

test('header control renders nothing without a Host path', () => {
  const module = loadModule()
  const client = module.factory(() => fakeReact)
  const { ctx, registrations } = harness()
  client.apply(ctx)

  const Button = registrations[0].component
  const tree = Button({
    openInBrowser: async () => ({ ok: true }),
    probeDesktop: async () => true,
    t: (key) => key,
  })

  assert.equal(tree, null)
})

