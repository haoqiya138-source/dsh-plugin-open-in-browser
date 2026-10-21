# Security policy

This plugin adds one capability to DSH: **launching a local file in the user's
default browser**. That is a process-launch capability, so it is deliberately
narrow, fenced at several layers, and documented here for reviewers.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

- Use GitHub's **Report a vulnerability** form (Security tab → Advisories) on the
  repository: `https://github.com/your-github-name/dsh-plugin-open-in-browser/security/advisories/new`
- Or email the maintainer listed in `package.json` (`author`).

Include the DSH version, the plugin version, the operating system, and a minimal
reproduction. We aim to acknowledge within 72 hours and to ship a fix in a patch
release.

## Threat model

Trust boundary: the browser half (page JavaScript on `dsh-app://app`) is untrusted
relative to the Host process. The Host web server already authenticates its own
UI; this plugin must not let *any* page that reaches that server spawn arbitrary
programs.

Assets protected:

1. The user's machine: no arbitrary command execution, no launch of a program the
   user did not choose by clicking the plugin's own control.
2. The user's files: the plugin opens exactly one file the user selected, and only
   if it passes the path gate.
3. Integrity of the DSH process: the route never loads untrusted modules, never
   evaluates request data, and is disposed with the plugin.

Out of scope:

- A local user who can already write `HKCU` (they can change their own file
  associations and run programs anyway).
- Content executed by the browser after launch: a page opened as `file://` runs
  with the browser's local-file rules. Opening an untrusted HTML file in the
  browser is the same risk as double-clicking it.
- DSH's own authentication of the web server (upstream).

## The only Host entry point

```
POST /dsh-plugin-open-in-browser/open
content-type: application/json
body: { "path": "<absolute local path>" }            // document-seat form
   or { "address": "dsh-resource://file/session/<sessionId>/<relative path>" }
→ 200 { ok: true, mode: "browser" | "association", path }
→ 4xx/5xx { ok: false, code }
```

Fences, in the order they run (`src/index.ts`):

1. **Method**: anything but `POST` → `405` with `allow: POST`.
2. **Media type**: `content-type` must be `application/json` (parameters
   ignored) → otherwise `415`. This forecloses HTML form posts and simple
   cross-site `text/plain` posts.
3. **Origin**: an absent `Origin` is accepted (local clients: curl, tests); a
   present `Origin` must be `dsh-app://app` or exactly `http(s)://<Host header>`
   → otherwise `403`. This blocks casual cross-site requests from ordinary web
   pages.
4. **Body size**: at most 16 KiB, counted while reading, never buffered past the
   ceiling → `413`.
5. **Shape**: JSON object with exactly one non-empty string of `path` or
   `address` → otherwise `400`.
6. **Resolution**: `address` is parsed with a strict grammar
   (`dsh-resource://file/`), the Session is looked up for its workspace root, and
   the relative path is joined onto that root. Unknown Session →
   `session-unavailable`, never a guessed root.
7. **Path gate** (shared with the browser half, `src/security.ts`): the path must
   be absolute; at most 32,767 characters; no NUL or control characters; no
   Win32 device namespace (`\\?\`, `\\.\`); no UNC path (`\\server\share`); no
   `.`/`..` segments; no reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
   `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension); extension on the
   whitelist; and, when an address supplied a workspace root, containment in
   that root.
8. **Symlink resolution**: the injected `realpath` runs after the raw gate, then
   the gate runs again on the resolved path. A symlink that leaves the workspace
   is rejected as `symlink-escape`; a missing file fails `realpath-failed`.
9. **Launch**: only after the route resolves a validated path does
   `openFileInBrowser` run. It spawns a **resolved executable with an argv
   array** (`spawn`, `shell: false`, `detached`, stdio ignored, no inherited
   stdio), never a shell command string. The file path is passed as one argv
   element (or as a `file://` URL for the Windows browser/association path).

The route holds no state, reads no environment variables from the request, and
returns no file contents or directory listings.

## Default-browser resolution

On Windows the launcher reads the user's own `UserChoice` association:

```
HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice
HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice
```

then `HKCR\<ProgId>\shell\open\command` to obtain the executable, and falls back
to well-known install paths for Chrome, Edge, Brave, Firefox, Vivaldi and Opera.
All registry reads are `reg.exe query` calls with fixed arguments; the parsed
ProgId is used to build a registry key path that is passed as a distinct argv
element, so a hostile ProgId cannot inject command text. The executable from the
registry is only accepted if `stat` says it is a regular file. The same trust
applies as double-clicking a file: the resolved program is the user's own
configured default browser.

If no browser resolves, the plugin degrades to the OS association
(`explorer.exe <file-uri>`, `open <path>`, `xdg-open <path>`), which is the DSH
Remote's own behavior. The route reports the mode it used.

## What the plugin does not do

- No Electron IPC, no `contextBridge`, no preload script: DSH plugins cannot
  reach the Electron main process, and this plugin does not try to.
- No shell, no `eval`, no dynamic import of request data, no network egress.
- No arbitrary program choice: the executable comes from the user's default
  browser or their OS association, never from the request.
- No file writes, deletes, renames, or directory creation.
- No background work: nothing runs until a user clicks the control.

## Hardening checklist for reviewers

- `src/security.ts` is pure (no I/O except the injected `realpath`) and is unit
  tested; the same gate runs in the browser half and in the Host route.
- `src/index.ts` only wires the gate to the launcher; every early return is a
  structured code.
- `src/browser.ts` never builds a command string; `launchDetached` takes a plan
  (`command`, `args`) and never a shell.
- `dist/` is built from `src/` in CI (`npm test` also rebuilds), so the
  published artifact and the sources cannot silently diverge.
