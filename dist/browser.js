/**
 * Host-side "open this file in a real browser" launcher.
 *
 * Why this exists: the Host Remote `session.openWorkspacePath` follows the OS
 * *file association*, so an `.html` file lands in the default browser (what the
 * user wants) but a `.png`, `.pdf`, or `.md` lands in whatever image viewer, PDF
 * reader, or editor owns that extension (not what the user wants when the button
 * says "open in browser"). This module resolves the user's *default browser* and
 * launches that executable on a `file://` URL instead.
 *
 * Resolution order on Windows:
 * 1. `HKCU\…\UrlAssociations\https\UserChoice` → `ProgId` →
 *    `HKCR\<ProgId>\shell\open\command`, i.e. the browser Windows itself would
 *    open a link with. This is the same choice the Start menu and every app use,
 *    and it survives installs/moves without a catalog to maintain.
 * 2. Well-known install paths for the mainstream browsers (Chrome, Edge, Brave,
 *    Firefox, Vivaldi, Opera) for a machine whose `https` handler is a packaged
 *    or per-user install the first probe cannot see.
 * 3. The OS association (`explorer.exe <file-uri>`), degraded but never silent.
 *
 * macOS and Linux fall back to the association (`open`, `xdg-open`): asking for
 * *a* browser there needs LaunchServices/`.desktop` parsing, which this plugin
 * deliberately does not own.
 *
 * All facts are injectable so the resolution logic is testable without spawning
 * anything (see `tests/browser.test.mjs`).
 */
import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { pathToFileURL } from 'node:url';
/** Probe budget for one `reg.exe` read; registry reads are local and fast. */
const REG_QUERY_TIMEOUT_MS = 4000;
/** Default window in which an immediate launcher failure is still visible. */
export const DEFAULT_LAUNCH_WATCH_MS = 2500;
/** The file manager fallback that always exists on Windows. */
const WINDOWS_ASSOCIATION_COMMAND = 'explorer.exe';
/**
 * Extract the executable from a registry `shell\open\command` value.
 *
 * Windows stores the command as a shell-ish string, conventionally
 * `"C:\…\chrome.exe" -- "%1"`. The quoted first token wins; an unquoted command
 * is taken up to the first space, which is the best a string parse can do and is
 * wrong only for a quoted-less path containing spaces (never written by Chrome,
 * Edge, Firefox, or any installer this launcher targets).
 */
export function parseCommandExecutable(commandLine) {
    if (typeof commandLine !== 'string')
        return undefined;
    const trimmed = commandLine.trim();
    if (trimmed === '')
        return undefined;
    if (trimmed.startsWith('"')) {
        const end = trimmed.indexOf('"', 1);
        if (end <= 1)
            return undefined;
        return trimmed.slice(1, end);
    }
    const first = /^[^\s]+/.exec(trimmed);
    return first === null ? undefined : first[0];
}
/**
 * Read one `REG_SZ`/`REG_EXPAND_SZ` value out of `reg.exe query` stdout.
 *
 * `reg.exe` prints `    <name>    <type>    <data>` per value and pads with
 * spaces, so the parser is deliberately tolerant about the whitespace between
 * the three fields. `(Default)` addresses the key's default value.
 */
export function parseRegStringValue(stdout, name) {
    if (typeof stdout !== 'string')
        return undefined;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'im');
    const match = pattern.exec(stdout);
    if (match === null)
        return undefined;
    const value = (match[1] ?? '').trim();
    return value === '' ? undefined : value;
}
/** Read the `ProgId` value out of a `UrlAssociations\…\UserChoice` query. */
export function parseUserChoiceProgId(stdout) {
    return parseRegStringValue(stdout, 'ProgId');
}
/**
 * Expand environment references the way `REG_EXPAND_SZ` does.
 *
 * Both forms appear in Windows registry data and in this module's own candidate
 * templates: `%NAME%` (the registry form) and `${NAME}` (the literal form, where a
 * name such as `ProgramFiles(x86)` would otherwise break a `%`-only pattern).
 * Unknown names are left untouched.
 */
export function expandEnvironment(template, env) {
    const lookup = (name) => env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()];
    return template
        .replace(/\$\{([^}]+)\}/g, (token, name) => lookup(name) ?? token)
        .replace(/%([^%]+)%/g, (token, name) => lookup(name) ?? token);
}
/**
 * Well-known browser executables, most common first.
 *
 * `${VAR}` templates resolve against the process environment (`ProgramFiles`,
 * `ProgramFiles(x86)`, `LOCALAPPDATA`) so a per-user Chrome install is found even
 * though it never appears in `%ProgramFiles%`. Entries are probed in order and
 * the first one that exists wins.
 */
export function windowsBrowserCandidates(facts) {
    const templates = [
        '${ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe',
        '${ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe',
        '${LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe',
        '${ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe',
        '${ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe',
        '${ProgramFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        '${ProgramFiles(x86)}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        '${ProgramFiles}\\Mozilla Firefox\\firefox.exe',
        '${ProgramFiles(x86)}\\Mozilla Firefox\\firefox.exe',
        '${ProgramFiles}\\Vivaldi\\Application\\vivaldi.exe',
        '${LOCALAPPDATA}\\Programs\\Opera\\launcher.exe',
        '${ProgramFiles}\\Opera\\launcher.exe',
    ];
    const seen = new Set();
    for (const template of templates) {
        const expanded = expandEnvironment(template, facts.env);
        if (expanded === template || expanded.includes('${'))
            continue;
        seen.add(expanded);
    }
    return [...seen];
}
/** The `UrlAssociations` schemes whose handler is, in practice, the default browser. */
const BROWSER_ASSOCIATION_SCHEMES = Object.freeze(['https', 'http']);
/**
 * Resolve the browser Windows would use for a link.
 *
 * Reads `UserChoice` for `https` then `http`, maps each `ProgId` to its
 * `shell\open\command`, and returns the executable when it still exists. A missing
 * `ProgId`, an unreadable key, or a stale executable all fall through to the next
 * candidate rather than failing the launch.
 */
export async function resolveWindowsBrowserPlan(facts) {
    if (facts.platform !== 'win32')
        return undefined;
    for (const scheme of BROWSER_ASSOCIATION_SCHEMES) {
        const key = `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;
        const userChoice = await facts.run('reg.exe', ['query', key, '/v', 'ProgId'], REG_QUERY_TIMEOUT_MS);
        const progId = parseUserChoiceProgId(userChoice);
        if (progId === undefined)
            continue;
        const commandKey = `HKCR\\${progId}\\shell\\open\\command`;
        const commandLine = parseRegStringValue(await facts.run('reg.exe', ['query', commandKey, '/ve'], REG_QUERY_TIMEOUT_MS), '(Default)');
        const executable = parseCommandExecutable(commandLine);
        if (executable !== undefined && (await facts.isFile(executable))) {
            return { mode: 'browser', command: executable, args: [] };
        }
    }
    for (const candidate of windowsBrowserCandidates(facts)) {
        if (await facts.isFile(candidate))
            return { mode: 'browser', command: candidate, args: [] };
    }
    return undefined;
}
/**
 * Launch one plan detached.
 *
 * Resolves `true` when the launcher either exited with an accepted code or was
 * still running when the watch window closed (browsers keep running, they do not
 * exit), and `false` for a spawn error or an unexpected early exit. Never kills
 * the child: a still-running browser is the success case.
 */
export async function launchDetached(plan, watchMs = DEFAULT_LAUNCH_WATCH_MS) {
    const accept = plan.acceptExitCodes ?? [0];
    return await new Promise((resolve) => {
        let settled = false;
        let timer;
        const settle = (launched) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            child.unref();
            resolve(launched);
        };
        const child = spawn(plan.command, [...plan.args], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        timer = setTimeout(() => settle(true), Math.max(1, watchMs));
        child.once('error', () => settle(false));
        child.once('exit', (code) => settle(code !== null && accept.includes(code)));
    });
}
/**
 * Build the ordered launch attempts for one file, without touching a process.
 *
 * The resolved browser comes first (it opens any whitelisted file type in a real
 * browser), then the OS association as the degraded attempt. `explorer.exe`
 * hands the URI to the registered handler and exits 1, so its plan accepts both
 * codes. Pure so the ordering is testable.
 */
export function buildLaunchPlans(path, platform, browser) {
    const url = pathToFileURL(path).href;
    const plans = [];
    if (browser !== undefined)
        plans.push({ ...browser, args: [url] });
    if (platform === 'win32') {
        plans.push({
            mode: 'association',
            command: WINDOWS_ASSOCIATION_COMMAND,
            args: [url],
            // explorer.exe hands the URI to the registered handler and exits 1.
            acceptExitCodes: [0, 1],
        });
    }
    else if (platform === 'darwin') {
        plans.push({ mode: 'association', command: 'open', args: [path] });
    }
    else {
        plans.push({ mode: 'association', command: 'xdg-open', args: [path] });
    }
    return plans;
}
/**
 * Open one file in the resolved browser, degrading to the OS association.
 *
 * @param path absolute file path the caller already validated.
 * @param facts injectable platform/executable facts.
 * @param watchMs launcher watch window.
 * @returns the mode that launched, or `undefined` when every attempt failed.
 */
export async function openFileInBrowser(path, facts, watchMs = DEFAULT_LAUNCH_WATCH_MS) {
    const browser = await resolveWindowsBrowserPlan(facts);
    for (const plan of buildLaunchPlans(path, facts.platform, browser)) {
        if (await launchDetached(plan, watchMs))
            return plan.mode;
    }
    return undefined;
}
/** Run one command with a deadline; `null` for any failure. */
function runBounded(command, args, timeoutMs) {
    return new Promise((resolve) => {
        execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            resolve(error === null ? stdout : null);
        });
    });
}
/** Whether a path is an existing regular file. */
async function isRegularFile(path) {
    try {
        return (await stat(path)).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Production facts for the running Host process.
 *
 * `home` and the environment come from the Host process, which is the same user
 * that installed the browsers; a plugin load therefore needs no configuration.
 */
export function createLaunchFacts(overrides = {}) {
    return {
        platform: overrides.platform ?? osPlatform(),
        env: overrides.env ?? process.env,
        home: overrides.home ?? homedir(),
        run: overrides.run ?? runBounded,
        isFile: overrides.isFile ?? isRegularFile,
    };
}
