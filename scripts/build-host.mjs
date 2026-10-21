#!/usr/bin/env node
/**
 * Compile the Host half (`src/index.ts` + `src/security.ts`) to `dist/`.
 *
 * No bundler is involved: the Host half is a plain ES module whose `apply` export
 * the Loader calls. `typescript` is the only build dependency.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.error('[build:host] typescript is not installed. Run `npm install` first.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const entry = resolve(root, 'dist', 'index.js')
if (!existsSync(entry)) {
  console.error(`[build:host] expected ${entry} after compilation.`)
  process.exit(1)
}

// Keep the built package honest: the published `files` list must not point at
// stale artifacts from an older build.
for (const stale of ['dist/client.js']) {
  rmSync(resolve(root, stale), { force: true })
}
mkdirSync(resolve(root, 'dist'), { recursive: true })

console.log('[build:host] dist/index.js ready')
