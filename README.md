# dsh-plugin-open-in-browser

A community DSH plugin that adds an **Open in browser** control to the document
preview, so a file picked in the sidebar opens in the **system default browser**
instead of the in-app preview.

## Why

The built-in preview renders HTML inside a sandboxed `iframe` (`srcDoc`/blob). Pages
that depend on `fetch`, modules, absolute paths, service workers, or a real origin
show up blank — and files the preview cannot render at all show an empty state. The
fastest escape hatch is the OS: hand the file to the default browser, which resolves
relative assets and origin-dependent APIs normally.

## What it is (and is not)

- **Is:** two slot contributions on the document preview header/empty state, both of
  which receive the previewed file's Host (absolute) path as `absolutePath`:
  - `sidebar.right.tab.document.actions` — header toolbar button.
  - `sidebar.right.tab.document.unpreviewable` — button inside the "cannot preview"
    empty state.
- **Is not:** a file-tree right-click menu. The catalog exposes no file-node
  context-menu slot (only `sidebar.right.tab.files.actions`, a toolbar that receives
  the displayed workspace directory), and the shipped Files tree has no context menu
  of its own. Adding one would require shipping a replacement file tree.
- **Is not:** an Electron integration. A client plugin has no main-process access and
  no `contextBridge` preload of its own; the supported bridge from the browser half to
  Node is the Host Remote.

## How opening works

The browser half calls the Host Remote that DSH already uses for "open with the
default application":

```js
await ctx.get('remote').session.openWorkspacePath({ path })   // → { ok: true }
```

`session.openWorkspacePath` re-verifies the Host path mapping and then launches the
native association. On Windows the host runs `explorer.exe <file-uri>`, which resolves
`.html` to the default browser; on macOS `open`; on Linux `xdg-open`. The same Remote
also exposes `canOpenWorkspacePath()` (used here to hide the control when the
deployment has no desktop) and `workspacePathApplications({ path })` (which apps are
registered for the file).

> Note: the request schema is `{ path, action?: 'reveal', application?: string }`.
> There is no `intent` field — omitting `action`/`application` *is* "open with the
> default application".

## Layout

```
src/security.ts   path-safety layer: absolute-path check, traversal/UNC/device
                  rejection, extension whitelist, workspace containment, and
                  symlink-escape detection via an injected realpath
src/client.ts     browser half: slot registrations + the Remote adapter
src/index.ts      host half: Loader row + reusable Host-side validators
locale/en.json    meta.title / meta.description + UI strings
locale/zh.json    same in Chinese
cordis.patch.yml  Loader insert row
scripts/*.mjs     tsc-driven builds (no bundler); the client build wraps the
                  compiled module in the DSH module-loader factory
tests/*.test.mjs  node:test suites for the safety layer and the built bundle
```

## Build

Requires Node ≥ 20 (verified on Node 24) and no runtime dependency.

```bash
npm install       # typescript + @types/node only
npm run build     # dist/index.js (host) + dist/client.js (browser artifact)
npm run typecheck # host and client configs
npm test          # builds, then runs both node:test suites
```

`npm run build` is the only step DSH needs: the package's `files` list and `exports`
point at `dist/`.

## Local test steps

1. **Build and unit-test**

   ```bash
   npm run build
   npm test
   ```

   Expected: `dist/index.js` and `dist/client.js` exist; all `node:test` cases pass.
   The client suite executes `dist/client.js` in a bare VM (only `window` +
   `require('react')`), asserts the loader id equals the package name, asserts both
   seats are registered, and drives `openInBrowser()` against a stub Remote — so the
   Remote call shape and every refusal path are covered without a GUI.

2. **Install into the current profile** (from an absolute package directory):

   ```
   plugin_manager  action=install_bundle  target=E:\Ai\DSHprojects\plug-in\open-in-browser
   ```

   A profile that already had this package installed must be restarted before the new
   artifact is loaded.

3. **Smoke-test in the GUI**

   - Open a session, open the Files tab, click an `.html` file → the preview tab
     appears with an **Open in browser** button in its header; clicking it launches
     the default browser.
   - Click a file the preview cannot render (e.g. an `.svg` that is not previewable,
     or any file type that hits the empty state) → the empty state shows the same
     action.
   - In a remote/SSH deployment (`canOpenWorkspacePath()` false) both controls stay
     hidden.
   - Refusals surface as a short inline message, never as a crash: a path with `..`,
     a non-whitelisted extension, or a path the Host cannot map is reported in the
     button itself.

4. **Uninstall**

   ```
   plugin_manager  action=set_plugin  target=dsh-plugin-open-in-browser  enabled=false
   ```

## Security notes

- The browser half validates the path before the Remote call: it must be absolute, it
  must not contain `.`/`..`, UNC or device-namespace paths, control characters, or
  reserved device names, and its extension must be on the browser-safe whitelist.
- Containment against the workspace root is enforced only when the caller supplies a
  root; on the document seats the root is not in the slot's props, so the Remote's
  Host-mapping verification is the authoritative fence (it rejects
  `Path has no verified Host path`).
- `validateResolvedTarget()` implements symlink-escape detection with an injected
  `realpath`, for callers that do know the root (Host code, tests).

## Limitations

- No file-tree context menu (see above).
- A profile restart is required after rebuilding, because the client artifact is
  cached by the module loader.
- The whitelist is deliberately small; extend `DEFAULT_ALLOWED_EXTENSIONS` if you want
  more types (e.g. `.mp4`) opened externally.
