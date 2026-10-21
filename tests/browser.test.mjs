/**
 * Unit tests for the Host-side browser resolver (`src/browser.ts` → `dist/browser.js`).
 *
 * Every system fact is injected, so these run without touching the registry, the
 * environment, or a process: `reg.exe` reads and file probes are fakes that return
 * canned Windows-shaped output.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  buildLaunchPlans,
  expandEnvironment,
  parseCommandExecutable,
  parseRegStringValue,
  parseUserChoiceProgId,
  resolveWindowsBrowserPlan,
  windowsBrowserCandidates,
} from '../dist/browser.js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/** One `reg.exe query …\UserChoice` answer. */
const USER_CHOICE_HTTPS = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
  '    ProgId    REG_SZ    ChromeHTML',
  '',
].join('\r\n')

/** One `reg.exe query HKCR\\<ProgId>\\shell\\open\\command /ve` answer. */
const CHROME_COMMAND = [
  'HKEY_CLASSES_ROOT\\ChromeHTML\\shell\\open\\command',
  '    (Default)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"',
  '',
].join('\r\n')

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
}

/**
 * Inject a platform plus canned command answers and file probes.
 *
 * `answers` maps a substring of the command line to stdout; the first matching
 * entry wins, otherwise the command "fails" with `null`.
 */
function fakeFacts({ platform = 'win32', env = ENV, files = [], answers = [] } = {}) {
  const probes = []
  const runs = []
  return {
    probes,
    runs,
    platform,
    env,
    home: 'C:\\Users\\me',
    run: async (command, args) => {
      const line = [command, ...args].join(' ')
      runs.push(line)
      for (const [needle, stdout] of answers) {
        if (line.includes(needle)) return stdout
      }
      return null
    },
    isFile: async (path) => {
      probes.push(path)
      return files.includes(path)
    },
  }
}

test('parseCommandExecutable reads the quoted registry command', () => {
  assert.equal(
    parseCommandExecutable('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"'),
    CHROME,
  )
})

test('parseCommandExecutable reads a quoted command without switches', () => {
  assert.equal(parseCommandExecutable('"C:\\Apps\\browser.exe"'), 'C:\\Apps\\browser.exe')
})

test('parseCommandExecutable takes the first token of an unquoted command', () => {
  assert.equal(parseCommandExecutable('C:\\Apps\\browser.exe %1'), 'C:\\Apps\\browser.exe')
})

test('parseCommandExecutable rejects a missing or empty command', () => {
  assert.equal(parseCommandExecutable(undefined), undefined)
  assert.equal(parseCommandExecutable(''), undefined)
  assert.equal(parseCommandExecutable('"unterminated'), undefined)
})

test('parseRegStringValue reads a REG_SZ value', () => {
  assert.equal(parseRegStringValue(CHROME_COMMAND, '(Default)'), `"${CHROME}" -- "%1"`)
})

test('parseRegStringValue matches the value name exactly, not as a prefix', () => {
  const output = '    ProgId    REG_SZ    ChromeHTML\r\n    ProgIdBackup    REG_SZ    Other\r\n'
  assert.equal(parseRegStringValue(output, 'ProgId'), 'ChromeHTML')
})

test('parseRegStringValue returns undefined for a missing value', () => {
  assert.equal(parseRegStringValue(undefined, 'ProgId'), undefined)
  assert.equal(parseRegStringValue('ERROR: The system was unable to find the specified registry key.', 'ProgId'), undefined)
})

test('parseUserChoiceProgId reads the ProgId value', () => {
  assert.equal(parseUserChoiceProgId(USER_CHOICE_HTTPS), 'ChromeHTML')
})

test('expandEnvironment replaces known variables and leaves unknown ones', () => {
  assert.equal(
    expandEnvironment('${ProgramFiles}\\Chrome\\chrome.exe', { ProgramFiles: 'C:\\Program Files' }),
    'C:\\Program Files\\Chrome\\chrome.exe',
  )
  assert.equal(expandEnvironment('%ProgramFiles%\\a.exe', ENV), 'C:\\Program Files\\a.exe')
  assert.equal(expandEnvironment('%UNKNOWN%\\a.exe', ENV), '%UNKNOWN%\\a.exe')
})

test('windowsBrowserCandidates expands the environment and skips unknown roots', () => {
  const candidates = windowsBrowserCandidates({ env: { ProgramFiles: 'P:\\Files' }, home: 'C:\\Users\\me' })
  assert.ok(candidates.length > 0)
  assert.equal(candidates[0], 'P:\\Files\\Google\\Chrome\\Application\\chrome.exe')
  assert.ok(candidates.every((candidate) => !candidate.includes('${')))
})

test('resolveWindowsBrowserPlan trusts the https UserChoice handler', async () => {
  const facts = fakeFacts({
    files: [CHROME, EDGE],
    answers: [
      ['https\\UserChoice', USER_CHOICE_HTTPS],
      ['ChromeHTML\\shell\\open\\command', CHROME_COMMAND],
    ],
  })
  const plan = await resolveWindowsBrowserPlan(facts)
  assert.deepEqual(plan, { mode: 'browser', command: CHROME, args: [] })
})

test('resolveWindowsBrowserPlan falls back to well-known install paths', async () => {
  const facts = fakeFacts({ files: [EDGE] })
  const plan = await resolveWindowsBrowserPlan(facts)
  assert.deepEqual(plan, { mode: 'browser', command: EDGE, args: [] })
})

test('resolveWindowsBrowserPlan returns undefined when nothing exists', async () => {
  const plan = await resolveWindowsBrowserPlan(fakeFacts())
  assert.equal(plan, undefined)
})

test('resolveWindowsBrowserPlan is Windows-only', async () => {
  const plan = await resolveWindowsBrowserPlan(fakeFacts({ platform: 'linux' }))
  assert.equal(plan, undefined)
})

test('buildLaunchPlans opens a browser first, then the OS association', () => {
  const path = 'C:\\Users\\me\\project\\preview.html'
  const plans = buildLaunchPlans(path, 'win32', { mode: 'browser', command: CHROME, args: [] })

  assert.equal(plans.length, 2)
  assert.equal(plans[0]?.mode, 'browser')
  assert.equal(plans[0]?.command, CHROME)
  // The browser receives a file URL for the target, built by the same
  // `pathToFileURL` the implementation uses (so this is platform-independent:
  // a Windows path encoded on a Linux runner still equals the computed URL).
  assert.equal(plans[0]?.args[0], pathToFileURL(path).href)
  assert.match(plans[0]?.args[0] ?? '', /^file:\/\/\//)
  assert.equal(plans[1]?.mode, 'association')
  assert.equal(plans[1]?.command, 'explorer.exe')
  assert.deepEqual(plans[1]?.acceptExitCodes, [0, 1])
})

test('buildLaunchPlans only uses the association when no browser was resolved', () => {
  const plans = buildLaunchPlans('C:\\Users\\me\\project\\a.png', 'win32', undefined)
  assert.equal(plans.length, 1)
  assert.equal(plans[0]?.mode, 'association')
  assert.match(plans[0]?.args[0] ?? '', /^file:\/\/\//)
})

test('buildLaunchPlans uses the platform opener outside Windows', () => {
  const mac = buildLaunchPlans('/Users/me/a.html', 'darwin', undefined)
  assert.deepEqual(mac, [{ mode: 'association', command: 'open', args: ['/Users/me/a.html'] }])

  const linux = buildLaunchPlans('/home/me/a.html', 'linux', undefined)
  assert.deepEqual(linux, [{ mode: 'association', command: 'xdg-open', args: ['/home/me/a.html'] }])
})
