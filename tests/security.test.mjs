/**
 * Unit tests for the pure path-safety layer (`src/security.ts` → `dist/security.js`).
 * Run with `npm test` (builds first) or `node --test tests/`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  extensionOf,
  isAllowedExtension,
  isContainedIn,
  normalizeForCompare,
  splitSegments,
  validateLocalFileTarget,
  validateResolvedTarget,
} from '../dist/security.js'

const ROOT = 'C:\\Users\\me\\project'
const INSIDE = 'C:\\Users\\me\\project\\pages\\preview.html'

test('accepts a local html file inside the workspace', () => {
  const result = validateLocalFileTarget({ path: INSIDE, root: ROOT })
  assert.deepEqual(result, { ok: true, path: INSIDE, extension: '.html' })
})

test('accepts a path without a root (slot does not know the workspace)', () => {
  const result = validateLocalFileTarget({ path: '/home/me/project/a.svg' })
  assert.equal(result.ok, true)
  assert.equal(result.ok === true ? result.extension : '', '.svg')
})

test('rejects an empty path', () => {
  assert.deepEqual(validateLocalFileTarget({ path: '   ' }), { ok: false, code: 'empty' })
})

test('rejects a relative path', () => {
  assert.deepEqual(validateLocalFileTarget({ path: 'pages/preview.html', root: ROOT }), {
    ok: false,
    code: 'not-absolute',
  })
})

test('rejects traversal instead of normalizing it', () => {
  assert.deepEqual(validateLocalFileTarget({ path: `${ROOT}\\..\\secret.html`, root: ROOT }), {
    ok: false,
    code: 'traversal',
  })
})

test('rejects a UNC share', () => {
  assert.deepEqual(validateLocalFileTarget({ path: '\\\\server\\share\\a.html' }), {
    ok: false,
    code: 'unc-path',
  })
})

test('rejects the Win32 device namespace', () => {
  assert.deepEqual(validateLocalFileTarget({ path: '\\\\?\\C:\\Users\\me\\project\\a.html' }), {
    ok: false,
    code: 'device-path',
  })
})

test('rejects reserved device names', () => {
  assert.deepEqual(validateLocalFileTarget({ path: 'C:\\Users\\me\\project\\CON.html' }), {
    ok: false,
    code: 'device-path',
  })
})

test('rejects control characters', () => {
  assert.deepEqual(validateLocalFileTarget({ path: `${ROOT}\\a\u0000b.html` }), {
    ok: false,
    code: 'control-chars',
  })
})

test('rejects an extension outside the whitelist', () => {
  assert.deepEqual(validateLocalFileTarget({ path: `${ROOT}\\tool.exe`, root: ROOT }), {
    ok: false,
    code: 'extension',
  })
})

test('respects a custom extension whitelist', () => {
  const result = validateLocalFileTarget({
    path: `${ROOT}\\notes.xyz`,
    root: ROOT,
    allowedExtensions: ['.xyz'],
  })
  assert.equal(result.ok, true)
})

test('rejects a file outside the workspace root', () => {
  assert.deepEqual(validateLocalFileTarget({ path: `${ROOT}2\\a.html`, root: ROOT }), {
    ok: false,
    code: 'outside-root',
  })
})

test('compares Windows containment case-insensitively', () => {
  const result = validateLocalFileTarget({ path: 'c:\\users\\ME\\project\\A.HTML', root: ROOT })
  assert.equal(result.ok, true)
  assert.equal(result.ok === true ? result.extension : '', '.html')
})

test('containment respects segment boundaries on POSIX roots', () => {
  assert.equal(isContainedIn('/home/me/ws/a.html', '/home/me/ws'), true)
  assert.equal(isContainedIn('/home/me/ws2/a.html', '/home/me/ws'), false)
  assert.equal(isContainedIn('/home/me/ws2', '/home/me/ws'), false)
})

test('normalizes duplicates, trailing separators, and Windows case', () => {
  assert.equal(normalizeForCompare('C:\\Users\\ME\\project\\'), 'c:/users/me/project')
  assert.equal(normalizeForCompare('/home//me/project//'), '/home/me/project')
})

test('extensionOf handles dot-files, case, and extension-less names', () => {
  assert.equal(extensionOf('C:\\a\\B.HTML'), '.html')
  assert.equal(extensionOf('/a/.env'), '')
  assert.equal(extensionOf('/a/Makefile'), '')
  assert.equal(extensionOf('/a/archive.tar.gz'), '.gz')
})

test('splitSegments drops separators and the drive prefix', () => {
  assert.deepEqual(splitSegments('C:\\Users\\me\\a.html'), ['Users', 'me', 'a.html'])
  assert.deepEqual(splitSegments('/home/me/a.html'), ['home', 'me', 'a.html'])
})

test('default whitelist covers the previewable document types', () => {
  for (const extension of ['.html', '.htm', '.xhtml', '.svg', '.pdf', '.md']) {
    assert.equal(isAllowedExtension(extension, DEFAULT_ALLOWED_EXTENSIONS), true, extension)
  }
  assert.equal(isAllowedExtension('.js', DEFAULT_ALLOWED_EXTENSIONS), false)
})

test('validateResolvedTarget accepts a link that stays inside the workspace', async () => {
  const result = await validateResolvedTarget({
    path: `${ROOT}\\shortcut.html`,
    root: ROOT,
    realpath: () => INSIDE,
  })
  assert.deepEqual(result, { ok: true, path: INSIDE, extension: '.html' })
})

test('validateResolvedTarget rejects a link that resolves outside the workspace', async () => {
  const result = await validateResolvedTarget({
    path: `${ROOT}\\shortcut.html`,
    root: ROOT,
    realpath: () => 'C:\\Users\\me\\outside\\secret.html',
  })
  assert.deepEqual(result, { ok: false, code: 'symlink-escape' })
})

test('validateResolvedTarget rejects an unresolved path', async () => {
  const result = await validateResolvedTarget({
    path: `${ROOT}\\missing.html`,
    root: ROOT,
    realpath: () => {
      throw new Error('ENOENT')
    },
  })
  assert.deepEqual(result, { ok: false, code: 'realpath-failed' })
})

test('validateResolvedTarget never resolves a path that already failed validation', async () => {
  let called = false
  const result = await validateResolvedTarget({
    path: `${ROOT}\\..\\secret.html`,
    root: ROOT,
    realpath: () => {
      called = true
      return INSIDE
    },
  })
  assert.deepEqual(result, { ok: false, code: 'traversal' })
  assert.equal(called, false)
})
