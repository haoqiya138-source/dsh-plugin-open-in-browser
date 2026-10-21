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
export declare const DEFAULT_ALLOWED_EXTENSIONS: readonly string[];
/** Why a target was refused. The browser half maps each code to a locale key. */
export type ValidationCode = 'empty' | 'control-chars' | 'too-long' | 'not-absolute' | 'unc-path' | 'device-path' | 'traversal' | 'extension' | 'outside-root' | 'realpath-failed' | 'symlink-escape';
/** One target to validate. `root` is optional: a slot that does not know the workspace root omits it. */
export interface ValidationRequest {
    readonly path: string;
    readonly root?: string | undefined;
    readonly allowedExtensions?: readonly string[] | undefined;
}
/** A validation outcome; on success it echoes the checked path and extension. */
export type ValidationResult = {
    readonly ok: true;
    readonly path: string;
    readonly extension: string;
} | {
    readonly ok: false;
    readonly code: ValidationCode;
};
/** A validation request that can resolve symlinks (Host-side or test-side). */
export interface RealPathRequest extends ValidationRequest {
    readonly realpath: (path: string) => string | Promise<string>;
}
/** Whether the value contains a C0/C1 control character. */
export declare function hasControlChars(value: string): boolean;
/** Whether the value is an absolute local path (Win32 drive or POSIX root). */
export declare function isAbsoluteLocalPath(value: string): boolean;
/** Whether the value addresses a UNC share. */
export declare function isUncPath(value: string): boolean;
/** Whether the value uses the `\\?\` or `\\.\` device namespace. */
export declare function isDeviceNamespacePath(value: string): boolean;
/** Whether one segment is a reserved Win32 device name. */
export declare function isDeviceName(segment: string): boolean;
/**
 * Split a path into its segments, dropping separators and the drive prefix.
 * Works for both Windows and POSIX input because the separator classes are mixed.
 */
export declare function splitSegments(value: string): string[];
/** Whether any segment is `.` or `..`. */
export declare function hasTraversalSegment(value: string): boolean;
/**
 * The lower-case extension of the last segment, including the dot.
 * Returns an empty string for dot-files (`.env`) and for extension-less names.
 */
export declare function extensionOf(value: string): string;
/**
 * Normalize a path for containment comparison only.
 * Windows-style paths (those with a drive letter) compare case-insensitively.
 */
export declare function normalizeForCompare(value: string): string;
/** Whether `target` is `root` itself or one of its descendants. */
export declare function isContainedIn(target: string, root: string): boolean;
/** Whether the extension is on the whitelist (case-insensitive, dot required). */
export declare function isAllowedExtension(extension: string, allowed?: readonly string[]): boolean;
/**
 * Validate one concrete file target.
 *
 * Order matters: cheap structural rejections come first so that a hostile path
 * never reaches the checks that need to reason about segments or extensions.
 */
export declare function validateLocalFileTarget(request: ValidationRequest): ValidationResult;
/**
 * Validate a target after resolving symbolic links.
 *
 * The raw path is checked first (so a traversal or device path never reaches the
 * filesystem), then the resolved path is re-checked, and finally containment in
 * `root` is re-tested against the resolved path. A link that points outside the
 * workspace therefore fails as `symlink-escape` rather than `outside-root`.
 */
export declare function validateResolvedTarget(request: RealPathRequest): Promise<ValidationResult>;
