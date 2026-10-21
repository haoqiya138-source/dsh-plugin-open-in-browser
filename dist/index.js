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
import { realpath } from 'node:fs/promises';
import { createLaunchFacts, openFileInBrowser } from './browser.js';
import { parseResourceFileAddress, validateLocalFileTarget, validateResolvedTarget } from './security.js';
/** Exact Host route this plugin owns. Kept beside the browser half's copy. */
export const ROUTE_PATH = '/dsh-plugin-open-in-browser/open';
/** Largest request body accepted; the contract is two short strings. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * Services the Host half needs.
 *
 * `webServer` serves the open route; `sessions` maps a tab's resource address
 * back to the Session workspace root it was opened from. The Host always
 * composes both (the Session API itself injects `sessions`).
 */
export const inject = Object.freeze(['webServer', 'sessions']);
/** Loader entry: register the route and let `ctx.effect` own its disposal. */
export function apply(context) {
    defineRoute(context);
}
/** Register the open route against the Host web server. */
function defineRoute(context) {
    context.effect(() => context.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (request, response) => handleOpen(context, request, response),
    }), `open-in-browser: POST ${ROUTE_PATH}`);
}
/** Answer one `POST /dsh-plugin-open-in-browser/open`. */
async function handleOpen(context, request, response) {
    if (!originAllowed(request)) {
        sendJson(response, 403, { ok: false, code: 'forbidden' });
        return;
    }
    if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        sendJson(response, 405, { ok: false, code: 'method-not-allowed' });
        return;
    }
    const mediaType = headerValue(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
        sendJson(response, 415, { ok: false, code: 'unsupported-media-type' });
        return;
    }
    const body = await readBoundedBody(request, MAX_BODY_BYTES);
    if (body.kind === 'too-large') {
        sendJson(response, 413, { ok: false, code: 'payload-too-large' });
        return;
    }
    if (body.kind === 'unreadable') {
        sendJson(response, 400, { ok: false, code: 'bad-request' });
        return;
    }
    const parsed = parseOpenRequestBody(body.text);
    if (parsed === undefined) {
        sendJson(response, 400, { ok: false, code: 'bad-request' });
        return;
    }
    const target = await resolveOpenTarget(context, parsed);
    if (!target.ok) {
        sendJson(response, 400, { ok: false, code: target.code });
        return;
    }
    const mode = await openFileInBrowser(target.path, createLaunchFacts());
    if (mode === undefined) {
        sendJson(response, 500, { ok: false, code: 'launch-failed', path: target.path });
        return;
    }
    sendJson(response, 200, { ok: true, mode, path: target.path });
}
/**
 * Parse the two-field body without a schema dependency.
 *
 * Both fields provided, neither provided, or a non-JSON body all read as
 * `undefined` so the caller answers one uniform 400.
 */
function parseOpenRequestBody(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    const path = typeof record['path'] === 'string' && record['path'] !== '' ? record['path'] : undefined;
    const address = typeof record['address'] === 'string' && record['address'] !== '' ? record['address'] : undefined;
    if (path !== undefined && address !== undefined)
        return undefined;
    if (path !== undefined)
        return { path };
    if (address !== undefined)
        return { address };
    return undefined;
}
/**
 * Turn either body form into a validated absolute path.
 *
 * A direct `path` is the document-preview seat's Host path; it was already
 * verified by the Host when the preview read the file, so there is no root to
 * confine against. An `address` names a Session workspace, whose root the Host
 * resolves here; the pure gate then rejects traversal, device paths, and — after
 * `realpath` — a symlink that leaves that workspace.
 */
async function resolveOpenTarget(context, body) {
    let path;
    let root;
    if (body.path !== undefined) {
        path = body.path;
    }
    else {
        const address = parseResourceFileAddress(body.address);
        if (address === undefined)
            return { ok: false, code: 'bad-address' };
        if (address.scope === 'absolute') {
            path = address.path;
        }
        else {
            const cwd = address.sessionId === undefined ? undefined : readSessionCwd(context, address.sessionId);
            if (cwd === undefined)
                return { ok: false, code: 'session-unavailable' };
            root = cwd;
            path = joinWorkspacePath(cwd, address.path);
        }
    }
    const realPathRequest = {
        path,
        realpath: (candidate) => realpath(candidate),
        ...(root === undefined ? {} : { root }),
    };
    const checked = await validateResolvedTarget(realPathRequest);
    if (!checked.ok)
        return { ok: false, code: checked.code };
    return { ok: true, path: checked.path };
}
/**
 * Read the workspace root of one Session.
 *
 * Mirrors what `@deepseek-ai/dsh-api-workspace-files` does to resolve a
 * `WorkspaceFileScope`: the live Session header first, else the persisted one.
 * This plugin only needs the live path the tab was opened from, so a Session the
 * process no longer knows is reported as unavailable rather than guessed at.
 */
function readSessionCwd(context, sessionId) {
    try {
        const sessions = context.get('sessions');
        if (sessions === undefined || sessions === null || typeof sessions.get !== 'function')
            return undefined;
        const session = sessions.get(sessionId);
        const cwd = session?.header?.cwd;
        return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
    }
    catch {
        return undefined;
    }
}
/** Join a workspace-relative resource path onto a Session root. */
export function joinWorkspacePath(root, relative) {
    const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
    const trimmedRoot = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
    if (normalized === '')
        return trimmedRoot;
    const separator = trimmedRoot.includes('\\') ? '\\' : '/';
    return `${trimmedRoot}${separator}${normalized.split('/').join(separator)}`;
}
/**
 * Same-origin fence for the route.
 *
 * The Host web server already authenticates its own UI, but this route can launch
 * a program, so a browser-sent `Origin` must name this Host (or the desktop
 * shell's own origin). A request with no `Origin` header is not a browser form
 * post — it is a local client such as curl or the test suite — and the Host's
 * loopback listener keeps that boundary unchanged from every other route.
 */
function originAllowed(request) {
    const origin = headerValue(request, 'origin');
    if (origin === undefined)
        return true;
    if (origin === 'dsh-app://app')
        return true;
    const host = headerValue(request, 'host');
    if (host === undefined)
        return false;
    return origin === `http://${host}` || origin === `https://${host}`;
}
/** First value of one request header, lower-cased name. */
function headerValue(request, name) {
    const raw = request.headers[name];
    if (Array.isArray(raw))
        return raw[0];
    return typeof raw === 'string' ? raw : undefined;
}
/** Read a bounded UTF-8 body; never buffers past `limit`. */
async function readBoundedBody(request, limit) {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            total += buffer.byteLength;
            if (total > limit) {
                // Finish consuming so the response is not cut off, but keep nothing.
                request.resume();
                return { kind: 'too-large' };
            }
            chunks.push(buffer);
        }
    }
    catch {
        return { kind: 'unreadable' };
    }
    return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') };
}
/** Write one JSON response without a framework. */
function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(payload);
}
/** Validate a path the same way the browser half does (Host-side reuse). */
export function validateTarget(request) {
    return validateLocalFileTarget(request);
}
/** Validate after symlink resolution, using the caller's `realpath`. */
export async function validateResolvedTargetForHost(request) {
    return validateResolvedTarget(request);
}
