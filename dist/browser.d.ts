/** How a file ended up being opened: browser, or the OS file association. */
export type LaunchMode = 'browser' | 'association';
/** One executable plus its complete argv and the mode it represents. */
export interface LaunchPlan {
    readonly mode: LaunchMode;
    readonly command: string;
    /** Complete arguments, including the target URL/path this plan opens. */
    readonly args: readonly string[];
    /** Exit codes that still mean "the launcher took over". */
    readonly acceptExitCodes?: readonly number[];
}
/** Facts the resolution needs; every one of them is injectable for tests. */
export interface LaunchFacts {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly home: string;
    /** Run one bounded command and return stdout, or `null` on any failure. */
    readonly run: (command: string, args: readonly string[], timeoutMs: number) => Promise<string | null>;
    /** Whether a path names an existing regular file. */
    readonly isFile: (path: string) => Promise<boolean>;
}
/** Default window in which an immediate launcher failure is still visible. */
export declare const DEFAULT_LAUNCH_WATCH_MS = 2500;
/**
 * Extract the executable from a registry `shell\open\command` value.
 *
 * Windows stores the command as a shell-ish string, conventionally
 * `"C:\…\chrome.exe" -- "%1"`. The quoted first token wins; an unquoted command
 * is taken up to the first space, which is the best a string parse can do and is
 * wrong only for a quoted-less path containing spaces (never written by Chrome,
 * Edge, Firefox, or any installer this launcher targets).
 */
export declare function parseCommandExecutable(commandLine: string | undefined): string | undefined;
/**
 * Read one `REG_SZ`/`REG_EXPAND_SZ` value out of `reg.exe query` stdout.
 *
 * `reg.exe` prints `    <name>    <type>    <data>` per value and pads with
 * spaces, so the parser is deliberately tolerant about the whitespace between
 * the three fields. `(Default)` addresses the key's default value.
 */
export declare function parseRegStringValue(stdout: string | null | undefined, name: string): string | undefined;
/** Read the `ProgId` value out of a `UrlAssociations\…\UserChoice` query. */
export declare function parseUserChoiceProgId(stdout: string | null | undefined): string | undefined;
/**
 * Expand environment references the way `REG_EXPAND_SZ` does.
 *
 * Both forms appear in Windows registry data and in this module's own candidate
 * templates: `%NAME%` (the registry form) and `${NAME}` (the literal form, where a
 * name such as `ProgramFiles(x86)` would otherwise break a `%`-only pattern).
 * Unknown names are left untouched.
 */
export declare function expandEnvironment(template: string, env: Readonly<Record<string, string | undefined>>): string;
/**
 * Well-known browser executables, most common first.
 *
 * `${VAR}` templates resolve against the process environment (`ProgramFiles`,
 * `ProgramFiles(x86)`, `LOCALAPPDATA`) so a per-user Chrome install is found even
 * though it never appears in `%ProgramFiles%`. Entries are probed in order and
 * the first one that exists wins.
 */
export declare function windowsBrowserCandidates(facts: Pick<LaunchFacts, 'env' | 'home'>): readonly string[];
/**
 * Resolve the browser Windows would use for a link.
 *
 * Reads `UserChoice` for `https` then `http`, maps each `ProgId` to its
 * `shell\open\command`, and returns the executable when it still exists. A missing
 * `ProgId`, an unreadable key, or a stale executable all fall through to the next
 * candidate rather than failing the launch.
 */
export declare function resolveWindowsBrowserPlan(facts: LaunchFacts): Promise<LaunchPlan | undefined>;
/**
 * Launch one plan detached.
 *
 * Resolves `true` when the launcher either exited with an accepted code or was
 * still running when the watch window closed (browsers keep running, they do not
 * exit), and `false` for a spawn error or an unexpected early exit. Never kills
 * the child: a still-running browser is the success case.
 */
export declare function launchDetached(plan: LaunchPlan, watchMs?: number): Promise<boolean>;
/**
 * Build the ordered launch attempts for one file, without touching a process.
 *
 * The resolved browser comes first (it opens any whitelisted file type in a real
 * browser), then the OS association as the degraded attempt. `explorer.exe`
 * hands the URI to the registered handler and exits 1, so its plan accepts both
 * codes. Pure so the ordering is testable.
 */
export declare function buildLaunchPlans(path: string, platform: NodeJS.Platform, browser: LaunchPlan | undefined): readonly LaunchPlan[];
/**
 * Open one file in the resolved browser, degrading to the OS association.
 *
 * @param path absolute file path the caller already validated.
 * @param facts injectable platform/executable facts.
 * @param watchMs launcher watch window.
 * @returns the mode that launched, or `undefined` when every attempt failed.
 */
export declare function openFileInBrowser(path: string, facts: LaunchFacts, watchMs?: number): Promise<LaunchMode | undefined>;
/**
 * Production facts for the running Host process.
 *
 * `home` and the environment come from the Host process, which is the same user
 * that installed the browsers; a plugin load therefore needs no configuration.
 */
export declare function createLaunchFacts(overrides?: Partial<LaunchFacts>): LaunchFacts;
