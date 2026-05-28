import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export function canonicalizePath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.)
 * or a URL protocol. Bare names and relative paths without ./ prefix
 * are considered local.
 */
export function isLocalPath(value) {
    const trimmed = value.trim();
    // Known non-local prefixes
    if (trimmed.startsWith("npm:") ||
        trimmed.startsWith("git:") ||
        trimmed.startsWith("github:") ||
        trimmed.startsWith("http:") ||
        trimmed.startsWith("https:") ||
        trimmed.startsWith("ssh:")) {
        return false;
    }
    return true;
}
function resolveAgainstCwd(filePath, cwd) {
    return isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(cwd, filePath);
}
export function getCwdRelativePath(filePath, cwd) {
    const resolvedCwd = resolvePath(cwd);
    const resolvedPath = resolveAgainstCwd(filePath, resolvedCwd);
    const relativePath = relative(resolvedCwd, resolvedPath);
    const isInsideCwd = relativePath === "" ||
        (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
    return isInsideCwd ? relativePath || "." : undefined;
}
export function formatPathRelativeToCwdOrAbsolute(filePath, cwd) {
    const absolutePath = resolveAgainstCwd(filePath, cwd);
    return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}
//# sourceMappingURL=paths.js.map