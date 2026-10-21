/**
 * Contract tests for the Host half (`src/index.ts` → `dist/index.js`).
 *
 * The route is driven through a fake `webServer` and fake Node request/response
 * objects, so every rejection path is pinned without launching anything or
 * touching the real filesystem. The launch itself is covered by `browser.test.mjs`;
 * here only the wire contract around it matters.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROUTE_PATH, apply, joinWorkspacePath } from '../dist/index.js'

/** Capture the single route the Host half registers. */
function mountHost({ sessionCwd } = {}) {
  let route
  const disposals = []
  const context = {
    webServer: {
      register: (registered) => {
        route = registered
        return () => disposals.push('disposed')
      },
    },
    effect: (register) => {
      const disposal = register()
      if (typeof disposal === 'function') disposals.push(disposal)
      return disposal
    },
    get: (service) => {
      if (service !== 'sessions') return undefined
      return {
        get: (id) => (sessionCwd === undefined ? undefined : { header: { id, cwd: sessionCwd } }),
      }
    },
  }
  apply(context)
  assert.ok(route !== undefined, 'apply did not register the open route')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, ROUTE_PATH)
  return { route, disposals }
}

/** Build a Node-shaped request: headers, method, and an async body iterable. */
function makeRequest({ method = 'POST', headers = {}, body = '' } = {}) {
  const payload = Buffer.from(body, 'utf8')
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload.byteLength > 0) yield payload
    },
  }
}

/** Build a Node-shaped response capturing status, headers, and body. */
function makeResponse() {
  const headers = {}
  return {
    statusCode: 0,
    headers,
    body: '',
    setHeader(name, value) {
      headers[name.toLowerCase()] = value
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
    },
  }
}

/** Send one request through the captured route and return the reply. */
async function call(route, request) {
  const response = makeResponse()
  await route.handler(request, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    json: response.body === '' ? undefined : JSON.parse(response.body),
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const INSIDE = 'C:\\Users\\me\\project\\preview.html'

test('rejects a non-POST method with 405 and an allow header', async () => {
  const { route } = mountHost()
  const reply = await call(route, makeRequest({ method: 'GET' }))

  assert.equal(reply.status, 405)
  assert.equal(reply.headers['allow'], 'POST')
  assert.equal(reply.json.code, 'method-not-allowed')
})

test('rejects a non-JSON content type with 415', async () => {
  const { route } = mountHost()
  const reply = await call(route, makeRequest({ headers: { 'content-type': 'text/plain' }, body: '{}' }))

  assert.equal(reply.status, 415)
  assert.equal(reply.json.code, 'unsupported-media-type')
})

test('rejects a foreign Origin with 403 before reading the body', async () => {
  const { route } = mountHost()
  const reply = await call(
    route,
    makeRequest({ headers: { ...JSON_HEADERS, origin: 'https://evil.example' }, body: JSON.stringify({ path: INSIDE }) }),
  )

  assert.equal(reply.status, 403)
  assert.equal(reply.json.code, 'forbidden')
})

test('accepts the desktop shell origin and the page origin', async () => {
  const { route } = mountHost()

  const shell = await call(
    route,
    makeRequest({ headers: { ...JSON_HEADERS, origin: 'dsh-app://app' }, body: '{not json' }),
  )
  assert.equal(shell.status, 400, 'the desktop origin passes the fence and fails later on the body')

  const page = await call(
    route,
    makeRequest({
      headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:7207', host: '127.0.0.1:7207' },
      body: '{not json',
    }),
  )
  assert.equal(page.status, 400)
})

test('rejects a malformed body with 400', async () => {
  const { route } = mountHost()
  const reply = await call(route, makeRequest({ headers: JSON_HEADERS, body: 'not json at all' }))

  assert.equal(reply.status, 400)
  assert.equal(reply.json.code, 'bad-request')
})

test('rejects a body that names both targets with 400', async () => {
  const { route } = mountHost()
  const reply = await call(
    route,
    makeRequest({ headers: JSON_HEADERS, body: JSON.stringify({ path: INSIDE, address: 'dsh-resource://file/' }) }),
  )

  assert.equal(reply.status, 400)
  assert.equal(reply.json.code, 'bad-request')
})

test('rejects a path traversal before resolving anything', async () => {
  const { route } = mountHost()
  const reply = await call(
    route,
    makeRequest({ headers: JSON_HEADERS, body: JSON.stringify({ path: 'C:\\Users\\me\\project\\..\\secret.html' }) }),
  )

  assert.equal(reply.status, 400)
  assert.equal(reply.json.code, 'traversal')
})

test('rejects a non-whitelisted extension', async () => {
  const { route } = mountHost()
  const reply = await call(
    route,
    makeRequest({ headers: JSON_HEADERS, body: JSON.stringify({ path: 'C:\\Users\\me\\project\\setup.exe' }) }),
  )

  assert.equal(reply.status, 400)
  assert.equal(reply.json.code, 'extension')
})

test('rejects an address that is not a DSH file address', async () => {
  const { route } = mountHost()
  const reply = await call(
    route,
    makeRequest({ headers: JSON_HEADERS, body: JSON.stringify({ address: 'https://example.com/a.html' }) }),
  )

  assert.equal(reply.status, 400)
  assert.equal(reply.json.code, 'bad-address')
})

test('reports an unknown Session as unavailable instead of guessing a root', async () => {
  const { route } = mountHost()
  const reply = await call(
    route,
    makeRequest({
      headers: JSON_HEADERS,
      body: JSON.stringify({ address: 'dsh-resource://file/session/gone/preview.html' }),
    }),
  )

  assert.equal(reply.status, 400)
  assert.equal(reply.json.code, 'session-unavailable')
})

test('marks every reply as non-cacheable JSON', async () => {
  const { route } = mountHost()
  const reply = await call(route, makeRequest({ headers: JSON_HEADERS, body: '{}' }))

  assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(reply.headers['cache-control'], 'no-store')
})

test('joinWorkspacePath keeps the root separator style', () => {
  assert.equal(joinWorkspacePath('C:\\Users\\me\\project', 'pages/preview.html'), 'C:\\Users\\me\\project\\pages\\preview.html')
  assert.equal(joinWorkspacePath('/home/me/project', 'pages/preview.html'), '/home/me/project/pages/preview.html')
  assert.equal(joinWorkspacePath('/home/me/project/', 'a.html'), '/home/me/project/a.html')
  assert.equal(joinWorkspacePath('/home/me/project', '/a.html'), '/home/me/project/a.html')
  assert.equal(joinWorkspacePath('/home/me/project', ''), '/home/me/project')
})
