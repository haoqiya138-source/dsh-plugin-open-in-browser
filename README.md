# dsh-plugin-open-in-browser

[![npm version](https://img.shields.io/npm/v/dsh-plugin-open-in-browser.svg)](https://www.npmjs.com/package/dsh-plugin-open-in-browser)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-open-in-browser.svg)](https://www.npmjs.com/package/dsh-plugin-open-in-browser)
[![CI](https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/blob/main/LICENSE)

A community DSH plugin that opens a Sidebar file in the **system default browser**
instead of the in-app preview.

Two entry points ship in one plugin:

| Seat | Where it shows | What it needs from the Host |
| --- | --- | --- |
| `sidebar.right.tab.document.unpreviewable` | "Cannot preview this file" empty state | the file's Host path (`absolutePath`) |
| `sidebar.right.tab.menu.item` | Right-click menu of a Sidebar **tab chip** | only the tab's `contentId` (`dsh-resource://file/session/…`) |

There is deliberately **no** `sidebar.right.tab.document.actions` seat. When the
preview renders a file, the header already carries the preview's own controls, and a
second "open in browser" button next to them earns nothing; the tab-chip menu is one
right-click away and works for every tab. That menu seat is also what makes the
plugin useful for a tab whose preview **fails**: the built-in preview only renders
the document seats once its Host metadata read succeeds, so a tab showing an error
(for example `HTTP 405` from a third-party previewer) has no `absolutePath`. The tab
menu still has the tab's resource address, which is enough to resolve, verify, and
open the file.

## Install

The package ships prebuilt artifacts (`dist/`), so installing needs no build step
and no runtime dependency.

**From npm** — published as
[`dsh-plugin-open-in-browser`](https://www.npmjs.com/package/dsh-plugin-open-in-browser):

1. Open DSH → **插件 → 添加插件**.
2. Enter the package name `dsh-plugin-open-in-browser`.
3. Fully quit and reopen DSH so the new Host half and client artifact load.

The same target works from the plugin tooling:

```
plugin_manager  action=install_bundle  target=dsh-plugin-open-in-browser
```

**From a local checkout or a GitHub clone** (the clone already contains `dist/`):

```
plugin_manager  action=install_bundle  target=<absolute path to the checkout>
```

**Requirements**: the DSH desktop app (the Host must be able to launch a native
application); Node ≥ 20 only when building from source. A remote/SSH deployment has
no desktop browser to launch, so the control reports that instead of failing
silently.

After any install, update, or rebuild, fully quit and reopen DSH: the client bundle
is cached by the module loader.

## Why

The built-in preview renders HTML inside a sandboxed `iframe` (`srcDoc`/blob). Pages
that depend on `fetch`, modules, absolute paths, service workers, or a real origin
show up blank — and files the preview cannot render at all show an empty state. The
fastest escape hatch is the OS: hand the file to the default browser, which resolves
relative assets and origin-dependent APIs normally.

## How opening works

The browser half posts to one exact Host route registered by this plugin's Host half:

```http
POST /dsh-plugin-open-in-browser/open
content-type: application/json

{ "path": "C:\\Users\\me\\project\\preview.html" }
{ "address": "dsh-resource://file/session/<sessionId>/pages/preview.html" }
```

`address` is the form a tab menu can produce: the Host resolves the Session's
workspace root (`sessions.get(sessionId).header.cwd`), joins the relative path,
then verifies the result (below). The reply is
`{ ok: true, mode: "browser" | "association", path }`; failures are
`{ ok: false, code }` with a 4xx/5xx status.

The Host half then resolves the user's **actual default browser** instead of relying
on the OS file association:

1. `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https|http\UserChoice`
   → `ProgId` → `HKCR\<ProgId>\shell\open\command` → executable;
2. well-known install paths (Chrome, Edge, Brave, Firefox, Vivaldi, Opera);
3. fallback: the OS association (`explorer.exe <file-uri>` on Windows, `open` on
   macOS, `xdg-open` on Linux).

This matters for images, PDFs, and other previewable files: the shipped
`session.openWorkspacePath` Remote follows the OS association (a `.png` opens the
Photos app on Windows), while this plugin promises a browser. If the Host route is
unavailable (older Host half, deployment without it), the browser half degrades to
that Remote so the control still does something useful.

> The Remote request schema is `{ path, action?: 'reveal', application?: string }`.
> There is no `intent` field — omitting `action`/`application` *is* "open with the
> default application".

## Relationship to DSH's shipped `open-in-app`

DSH already ships `@deepseek-ai/dsh-host-open-in-app` +
`@deepseek-ai/dsh-client-ui-open-in-app`, which register the document-preview seats
(`…document.actions` and `…document.unpreviewable`) with an "Open in app" menu
(editors, Git GUIs, terminals). This plugin is not a replacement: it is a
single-purpose shortcut for "just open it in the browser", including files that
plugin's own preview cannot render, and it adds the tab-chip menu.

## Layout

```
src/security.ts   path-safety layer: absolute-path check, traversal/UNC/device
                  rejection, extension whitelist, workspace containment, symlink
                  escape detection via an injected realpath, and the
                  dsh-resource://file/… address parser
src/browser.ts    Host-side default-browser resolver: registry UserChoice → ProgId →
                  command, well-known install paths, detached launch with a
                  watch window
src/index.ts      Host half: registers the one route, resolves address → workspace
                  path, validates, launches
src/client.ts     browser half: two slot registrations + route/Remote adapter
locale/en.json    meta.title / meta.description
locale/zh.json    same in Chinese
cordis.patch.yml  Loader insert row
scripts/*.mjs     tsc-driven builds (no bundler); the client build wraps the
                  compiled module in the DSH module-loader factory
tests/*.test.mjs  node:test suites: safety layer, browser resolver, Host route
                  contract, and the built client bundle
```

### Why no `src/main/`, `src/preload/`, `src/renderer/`?

Those are the layers of an **Electron application**. A DSH plugin is a Cordis
bundle, not an Electron app: it never reaches the Electron main process and DSH
exposes no preload/`contextBridge` bridge to plugins. The equivalent split is:

| Electron app layer | This plugin |
| --- | --- |
| main process (Node) | `src/index.ts` + `src/browser.ts` — the Host half, running inside DSH's Host process |
| preload / contextBridge | the Host route `POST /dsh-plugin-open-in-browser/open` (with DSH's `session.openWorkspacePath` Remote as the fallback) |
| renderer injection | `src/client.ts` — the browser artifact loaded through `window.__ModuleLoader__` |

`security.ts` is shared by both halves on purpose: the browser half validates
before calling, and the Host validates again before launching. Splitting it into
a "main" copy would let the two gates drift apart.

## Build

Requires Node ≥ 20 (verified on Node 24) and no runtime dependency.

```bash
npm install       # typescript + @types/node only
npm run build     # dist/index.js + dist/browser.js (host) + dist/client.js (browser)
npm run typecheck # host and client configs
npm test          # builds, then runs all four node:test suites
```

`npm run build` is the only step DSH needs: the package's `files` and `exports`
point at `dist/`.

## Local test steps

1. **Build and unit-test**

   ```bash
   npm run build
   npm test
   ```

   Expected: `dist/index.js`, `dist/browser.js`, and `dist/client.js` exist; all
   `node:test` cases pass (currently 78). The suites cover the pure safety layer and
   address grammar, the Windows registry/path resolution and launch-plan ordering
   (with injected process facts), the HTTP contract of the Host route (405/415/403/
   400 paths and the Origin fence), and the built client bundle executed in a bare VM
   (loader id, two registrations, route-first behavior with Remote fallback, and the
   refusal paths).

2. **Install into the current profile** (from an absolute package directory):

   ```
   plugin_manager  action=install_bundle  target=E:\Ai\DSHprojects\plug-in\open-in-browser
   ```

   A profile that already had this package installed must be restarted before the new
   artifact is loaded. When the profile links the workspace directory (as the local
   development setup does), rebuilding is enough; only the restart is required.

3. **Smoke-test in the GUI**

   - Open a session, open the Files tab, click a file the preview renders (an `.html`
     page, a `.png`) → the preview header carries **no** extra browser button; the
     file is meant to be read in place.
   - **Right-click the tab chip** and choose **Open in browser** → the tab's file is
     handed to the system default browser (not the OS file association), for any file
     type on the whitelist — an image opens in the browser instead of Photos.
   - Click a tab whose preview fails (for example a third-party previewer showing
     `HTTP 405`) → the same right-click item resolves the tab's resource address and
     opens the file.
   - In a remote/SSH deployment (`canOpenWorkspacePath()` false and no Host route) the
     document controls stay hidden and the menu item reports that the Host route is
     unavailable.
   - Refusals surface as short inline text, never as a crash: a path with `..`, a
     non-whitelisted extension, a foreign `Origin`, or a path the Host cannot map is
     reported.

4. **Uninstall**

   ```
   plugin_manager  action=set_plugin  target=dsh-plugin-open-in-browser  enabled=false
   ```

## Security notes

- The route is fenced on three layers: the Host web server's own authentication, a
  same-origin `Origin` check (`dsh-app://app` or the serving `Host`; absent `Origin`
  is a local client such as curl), and a bounded JSON body (`16 KiB`,
  `content-type: application/json` required). It can only ever open a **file** path
  that passes validation, never accept a command.
- The browser half validates before calling: the path must be absolute, must not
  contain `.`/`..`, UNC or device-namespace paths, control characters, or reserved
  device names, and its extension must be on the browser-safe whitelist.
- Address-based requests are resolved against the Session's live `header.cwd`, then
  passed through the same gate **and** an injected `realpath`; a symlink that leaves
  the workspace is rejected (`symlink-escape`), as is an unknown Session
  (`session-unavailable`) rather than guessing a root.
- Containment against a workspace root is only possible where a root is known; on the
  document seats the slot only supplies the absolute path, so the Host mapping check
  of the Remote (and of the preview itself) remains the authoritative fence there.

## Limitations

- No file-tree right-click menu. The slot catalog exposes no file-node context-menu
  slot (only `sidebar.right.tab.files.actions`, a toolbar that receives the displayed
  workspace directory), and the shipped Files tree has no context menu of its own.
  Adding one would require shipping a replacement file tree (what
  `dsh-better-sidebar` does).
- The empty-state button only appears once the preview has metadata for the file
  (`absolutePath`); a tab whose preview fails is covered by the tab-chip menu seat.
- The preview header has no button at all by design (see above); if you want one back,
  re-register `sidebar.right.tab.document.actions` in `src/client.ts`.
- A profile restart is required after rebuilding, because the client artifact is
  cached by the module loader.
- The whitelist is deliberately small; extend `DEFAULT_ALLOWED_EXTENSIONS` if you want
  more types opened externally.

## Security

The plugin adds a process-launch capability, so it ships with a written threat
model: the single Host route, the fences around it, the path gate, and what is
explicitly out of scope. See [docs/SECURITY.md](docs/SECURITY.md).

To report a vulnerability, use GitHub's private advisory form (Security tab) rather
than a public issue.

## Releasing

Repository: <https://github.com/haoqiya138-source/dsh-plugin-open-in-browser>.
The package is published to npm as
[`dsh-plugin-open-in-browser`](https://www.npmjs.com/package/dsh-plugin-open-in-browser).

`0.2.0` (2026-10-21) was the first public release.

Release checklist:

1. `npm test` (rebuilds `dist/` and runs all 78 cases) and `npm run typecheck`.
2. `npm version <patch|minor|major>` — bumps `package.json`, commits and creates the tag.
3. Publish with 2FA: `npm publish --access public` from this machine. The CLI prints
   an `https://www.npmjs.com/auth/cli/...` URL; open it, approve, and the publish
   completes. (npm requires an interactive second factor for publishing; an access
   token alone returns `EOTP`.)
4. `git push origin main --follow-tags` — the tag runs
   `.github/workflows/release.yml`, which rebuilds, tests and creates the GitHub
   release. Until npm **Trusted Publishing** is configured (below), that workflow
   skips `npm publish` so the release stays green.

### Continuous publishing (optional)

npm's supported token-free path is
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers):

1. On npmjs.com open the package → **Settings → Trusted publishing**.
2. Add a **GitHub Actions** publisher: repository
   `haoqiya138-source/dsh-plugin-open-in-browser`, workflow `release.yml`,
   environment left empty.
3. In `.github/workflows/release.yml`, drop the `NPM_TOKEN` guard and the
   `NODE_AUTH_TOKEN` env from the publish step — the runner's OIDC token
   (`id-token: write`, already set) authenticates `npm publish --provenance`.

Access tokens with "bypass 2FA" do not help: for accounts in the `auth-and-writes`
mode npm still answers `EOTP` for direct publishing, which is why the workflow keeps
the token guard as a safe default.

CI (`.github/workflows/ci.yml`) runs the typecheck and all 78 test cases on Linux
and Windows for Node 20 and 22. The release workflow rebuilds `dist/` before
publishing, so the tarball always matches the tagged source.

## License

[MIT](LICENSE)

