# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-22

### Changed

- Release automation now publishes through **npm Trusted Publishing** (GitHub
  Actions OIDC): the tag workflow authenticates `npm publish --provenance` with the
  runner's identity token instead of a stored `NPM_TOKEN` secret. No runtime
  change; the plugin bytes are identical to `0.2.0` apart from the version field.

### Notes

- npm requires one publish after a Trusted Publisher is configured to verify it;
  this release is that verification.

## [0.2.0] - 2026-10-21

First public release.

### Added

- `sidebar.right.tab.menu.item` seat: **Open in browser** in a Sidebar tab
  chip's right-click menu. It reads the tab's `contentId`
  (`dsh-resource://file/session/<sessionId>/<relative path>`) and needs no
  preview metadata, so it also works for tabs whose preview fails.
- `sidebar.right.tab.document.unpreviewable` seat: the same action in the
  "cannot preview this file" empty state.
- Host route `POST /dsh-plugin-open-in-browser/open` that takes `{ path }` or
  `{ address }`, resolves the address against the Session workspace root,
  validates the target, and launches it.
- Host-side default-browser resolution: Windows
  `UrlAssociations\https|http\UserChoice` → `ProgId` → `HKCR\<ProgId>\shell\open\command`,
  then well-known install paths (Chrome, Edge, Brave, Firefox, Vivaldi, Opera),
  then the OS file association as the degraded attempt. macOS uses `open`,
  Linux uses `xdg-open`. This makes images and PDFs open in the browser rather
  than in the OS default viewer.
- Shared path-safety module (`src/security.ts`): absolute-path enforcement,
  traversal and UNC/device-path rejection, reserved device names, extension
  whitelist, workspace containment, symlink-escape detection through an
  injected `realpath`, and the `dsh-resource://file/` address grammar.
- Route hardening: same-origin `Origin` fence (plus `dsh-app://app`), `POST`
  only, `application/json` required, 16 KiB body ceiling, structured error
  codes, no command strings — only an argv array to a resolved executable.
- Test suites (78 cases): safety layer, browser resolver, Host route contract,
  and the built client bundle executed in a bare VM.

### Notes

- A profile restart is required after installing or rebuilding, because the
  client artifact is cached by the module loader.
- There is no file-tree right-click menu: DSH's slot catalog exposes no
  file-node context-menu seat. The tab-chip menu is the nearest supported seat.

## [0.1.0] - 2026-10-21

### Added

- Initial scaffold: bundle manifest (`cordis.patch.yml`), Host half, client
  artifact build, security layer, `sidebar.right.tab.document.actions` and
  `sidebar.right.tab.document.unpreviewable` seats, locale files, and tests.

[Unreleased]: https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/releases/tag/v0.2.0
[0.1.0]: https://github.com/haoqiya138-source/dsh-plugin-open-in-browser/releases/tag/v0.1.0
