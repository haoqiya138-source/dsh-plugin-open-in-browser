/**
 * Host half of `dsh-plugin-open-in-browser`.
 *
 * The browser half needs a capability the renderer does not have: launching a
 * native application on a local path. DSH keeps that on the Host, and this half
 * exposes exactly one narrow route for it:
 *
 * ```
 * POST /dsh-plugin-open-in-browser/open
 * { "path": "<absolute local path>" }
 * { "address": "dsh-resource://file/session/<sessionId>/<workspace-relative path>" }
 * → 200 { ok: true, mode: "browser" | "association", path: "<resolved absolute path>" }
 * ```
 *
 * The `address` form is what a Sidebar tab knows: dockkit hands a tab-menu
 * contribution the tab's `contentId`, which for a document tab is exactly that
 * resource address. The Host resolves it against the Session's workspace root
 * (`sessions.get(sessionId).header.cwd`), which is the same mapping the shipped
 * `workspaceFiles` service uses, then validates the result with the same pure
 * gate the browser half already runs.
 *
 * Why a route instead of the Host Remote: `session.openWorkspacePath` follows the
 * OS *file association*, so `.html` reaches a browser but `.png` reaches Photos.
 * The button promises a browser, so the route resolves the user's actual default
 * browser (`browser.ts`) and launches that; the OS association stays as the
 * degraded attempt. The route is authenticated by the Host's own web server and
 * additionally fenced here (same-origin `Origin`, `POST`, JSON body, bounded
 * read, path validation) because any page served from the same loopback server
 * must not be able to launch arbitrary programs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RealPathRequest, ValidationRequest, ValidationResult } from './security.js';
/** Exact Host route this plugin owns. Kept beside the browser half's copy. */
export declare const ROUTE_PATH = "/dsh-plugin-open-in-browser/open";
/** Plugin config; currently empty and kept explicit so future fields stay typed. */
export interface OpenInBrowserConfig {
    /** Optional extension whitelist override for Host-side callers. */
    readonly allowedExtensions?: readonly string[];
}
/**
 * Services the Host half needs.
 *
 * `webServer` serves the open route; `sessions` maps a tab's resource address
 * back to the Session workspace root it was opened from. The Host always
 * composes both (the Session API itself injects `sessions`).
 */
export declare const inject: readonly string[];
/** Structural view of the `webServer` service surface this plugin uses. */
interface WebServerLike {
    register: (route: {
        readonly kind: 'exact';
        readonly path: string;
        readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
    }) => unknown;
}
/** The slice of the Cordis Host context this plugin uses. */
export interface HostContextLike {
    readonly webServer: WebServerLike;
    readonly effect: (register: () => unknown, label?: string) => unknown;
    get: (service: string) => unknown;
}
/** Loader entry: register the route and let `ctx.effect` own its disposal. */
export declare function apply(context: HostContextLike): void;
/** Join a workspace-relative resource path onto a Session root. */
export declare function joinWorkspacePath(root: string, relative: string): string;
/** Validate a path the same way the browser half does (Host-side reuse). */
export declare function validateTarget(request: ValidationRequest): ValidationResult;
/** Validate after symlink resolution, using the caller's `realpath`. */
export declare function validateResolvedTargetForHost(request: RealPathRequest): Promise<ValidationResult>;
export {};
