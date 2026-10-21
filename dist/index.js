/**
 * Host half of `dsh-plugin-open-in-browser`.
 *
 * It intentionally owns almost nothing: the actual "open with the OS default
 * application" action already exists in the Host Remote
 * `session.openWorkspacePath`, whose implementation verifies the Host path
 * mapping and then launches the native association (on Windows
 * `explorer.exe <file-uri>`, which resolves `.html` to the default browser).
 *
 * A plugin must not re-implement that launch path: `dsh-native-command` exposes
 * `openNativeAssociatedPath` for Host code, but the Remote is the supported,
 * already-fenced surface (it rejects paths that have no verified Host mapping
 * and it is what the shipped `open-in-app` UI uses). The browser half therefore
 * calls the Remote and this half stays a Loader row that can grow a route or a
 * setting later without changing the client contract.
 *
 * Exported helpers are for reuse by Host-side code and by the test suite; this
 * package deliberately registers no service, route, tool, or command.
 */
import { validateLocalFileTarget, validateResolvedTarget } from './security.js';
/** Services the Host half needs. It uses none, so the list is empty. */
export const inject = Object.freeze([]);
/**
 * Loader entry. Called once per profile load; owning no resource means nothing
 * to clean up, which keeps the row safe to reload.
 */
export function apply() {
    // The browser half talks to `session.openWorkspacePath`; the Host half only
    // publishes this row so the bundle's client artifact is mounted.
}
/** Validate a path the same way the browser half does (Host-side reuse). */
export function validateTarget(request) {
    return validateLocalFileTarget(request);
}
/** Validate after symlink resolution, using the caller's `realpath`. */
export async function validateResolvedTargetForHost(request) {
    return validateResolvedTarget(request);
}
