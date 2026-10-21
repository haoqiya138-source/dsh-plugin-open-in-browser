/**
 * Path safety for "open this sidebar file in the system browser".
 *
 * The browser half does not have Node built-ins, so every check here is pure and
 * synchronous except {@link validateResolvedTarget}, which takes the `realpath`
 * implementation as a dependency: the browser half passes none (the Host Remote
 * `session.openWorkspacePath` performs the authoritative Host-path and realpath
 * verification), while a Host-side caller — and the tests — can pass
 * `fs.realpath.native` to detect symlink escapes before anything is launched.
 *
 * Design rules:
 * - Reject anything that is not an absolute local path: relative paths, UNC
 *   shares, and Win32 device namespaces (`\\?\`, `\\.\`) are refused rather than
 *   "fixed up", because a browser launch of a device path is not a user intent.
 * - Reject `.` and `..` segments outright instead of normalizing them; a path
 *   the user could not have clicked (there is no `..` row in the file tree) is a
 *   symptom of tampering, not something to repair silently.
 * - Keep only a whitelist of extensions a browser can display. This is a safety
 *   net, not a security boundary: the boundary is the Host Remote's own check.
 */
/** Extensions the system browser can render as a document or an image. */
export const DEFAULT_ALLOWED_EXTENSIONS = Object.freeze([
    '.html',
    '.htm',
    '.xhtml',
    '.svg',
    '.pdf',
    '.txt',
    '.md',
    '.xml',
    '.json',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
]);
/** Longest path Windows accepts with the long-path aware APIs. */
const MAX_PATH_LENGTH = 32767;
/** NUL and the other C0/C1 control characters never belong in a real path. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** `C:\` or `C:/`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** `\\server\share`. */
const UNC_PREFIX = /^\\\\/;
/** `\\?\` and `\\.\` device namespaces. */
const DEVICE_NAMESPACE = /^\\\\[.?]\\/;
/** Win32 device names, with or without an extension (`CON`, `CON.html`). */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** A single path segment that the file tree can never produce. */
const TRAVERSAL_SEGMENT = /^(?:\.|\.\.)$/;
/** Whether the value contains a C0/C1 control character. */
export function hasControlChars(value) {
    return CONTROL_CHARACTER.test(value);
}
/** Whether the value is an absolute local path (Win32 drive or POSIX root). */
export function isAbsoluteLocalPath(value) {
    return WINDOWS_ABSOLUTE.test(value) || value.startsWith('/');
}
/** Whether the value addresses a UNC share. */
export function isUncPath(value) {
    return UNC_PREFIX.test(value) && !DEVICE_NAMESPACE.test(value);
}
/** Whether the value uses the `\\?\` or `\\.\` device namespace. */
export function isDeviceNamespacePath(value) {
    return DEVICE_NAMESPACE.test(value);
}
/** Whether one segment is a reserved Win32 device name. */
export function isDeviceName(segment) {
    return DEVICE_NAME.test(segment);
}
/**
 * Split a path into its segments, dropping separators and the drive prefix.
 * Works for both Windows and POSIX input because the separator classes are mixed.
 */
export function splitSegments(value) {
    return value
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0 && !/^[A-Za-z]:$/.test(segment));
}
/** Whether any segment is `.` or `..`. */
export function hasTraversalSegment(value) {
    return splitSegments(value).some((segment) => TRAVERSAL_SEGMENT.test(segment));
}
/**
 * The lower-case extension of the last segment, including the dot.
 * Returns an empty string for dot-files (`.env`) and for extension-less names.
 */
export function extensionOf(value) {
    const segments = splitSegments(value);
    const leaf = segments.length === 0 ? '' : segments[segments.length - 1] ?? '';
    const dot = leaf.lastIndexOf('.');
    if (dot <= 0)
        return '';
    return leaf.slice(dot).toLowerCase();
}
/**
 * Normalize a path for containment comparison only.
 * Windows-style paths (those with a drive letter) compare case-insensitively.
 */
export function normalizeForCompare(value) {
    const unified = value.replace(/\\/g, '/');
    const lowered = /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
    const collapsed = lowered.replace(/\/{2,}/g, '/');
    if (collapsed.length <= 1)
        return collapsed;
    return collapsed.replace(/\/+$/, '');
}
/** Whether `target` is `root` itself or one of its descendants. */
export function isContainedIn(target, root) {
    const normalizedRoot = normalizeForCompare(root);
    if (normalizedRoot.length === 0)
        return false;
    const normalizedTarget = normalizeForCompare(target);
    if (normalizedTarget === normalizedRoot)
        return true;
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedTarget.startsWith(prefix);
}
/** Whether the extension is on the whitelist (case-insensitive, dot required). */
export function isAllowedExtension(extension, allowed = DEFAULT_ALLOWED_EXTENSIONS) {
    const normalized = extension.toLowerCase();
    if (!normalized.startsWith('.') || normalized.length < 2)
        return false;
    return allowed.some((candidate) => candidate.toLowerCase() === normalized);
}
/**
 * Validate one concrete file target.
 *
 * Order matters: cheap structural rejections come first so that a hostile path
 * never reaches the checks that need to reason about segments or extensions.
 */
export function validateLocalFileTarget(request) {
    const path = typeof request.path === 'string' ? request.path : '';
    if (path.trim().length === 0)
        return { ok: false, code: 'empty' };
    if (hasControlChars(path))
        return { ok: false, code: 'control-chars' };
    if (path.length > MAX_PATH_LENGTH)
        return { ok: false, code: 'too-long' };
    if (isDeviceNamespacePath(path))
        return { ok: false, code: 'device-path' };
    if (isUncPath(path))
        return { ok: false, code: 'unc-path' };
    if (!isAbsoluteLocalPath(path))
        return { ok: false, code: 'not-absolute' };
    if (hasTraversalSegment(path))
        return { ok: false, code: 'traversal' };
    const segments = splitSegments(path);
    if (segments.some((segment) => isDeviceName(segment)))
        return { ok: false, code: 'device-path' };
    const extension = extensionOf(path);
    if (!isAllowedExtension(extension, request.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS)) {
        return { ok: false, code: 'extension' };
    }
    const root = request.root;
    if (root !== undefined && root.length > 0 && !isContainedIn(path, root)) {
        return { ok: false, code: 'outside-root' };
    }
    return { ok: true, path, extension };
}
/**
 * Validate a target after resolving symbolic links.
 *
 * The raw path is checked first (so a traversal or device path never reaches the
 * filesystem), then the resolved path is re-checked, and finally containment in
 * `root` is re-tested against the resolved path. A link that points outside the
 * workspace therefore fails as `symlink-escape` rather than `outside-root`.
 */
export async function validateResolvedTarget(request) {
    const direct = validateLocalFileTarget(request);
    if (!direct.ok)
        return direct;
    let resolved;
    try {
        resolved = await request.realpath(direct.path);
    }
    catch {
        return { ok: false, code: 'realpath-failed' };
    }
    const afterResolve = validateLocalFileTarget({
        path: resolved,
        ...(request.allowedExtensions === undefined ? {} : { allowedExtensions: request.allowedExtensions }),
    });
    if (!afterResolve.ok)
        return afterResolve;
    const root = request.root;
    if (root !== undefined && root.length > 0 && !isContainedIn(resolved, root)) {
        return { ok: false, code: 'symlink-escape' };
    }
    return { ok: true, path: resolved, extension: afterResolve.extension };
}
