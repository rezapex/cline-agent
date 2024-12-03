import * as path from "path";
import os from "os";

function toPosixPath(p: string) {
    const isExtendedLengthPath = p.startsWith("\\\\?\\");

    if (isExtendedLengthPath) {
        return p;
    }

    return p.replace(/\\/g, "/");
}

declare global {
    interface String {
        toPosix(): string;
    }
}

String.prototype.toPosix = function (this: string): string {
    return toPosixPath(this);
}

export function arePathsEqual(path1?: string, path2?: string): boolean {
    if (!path1 && !path2) {
        return true;
    }
    if (!path1 || !path2) {
        return false;
    }

    path1 = normalizePath(path1);
    path2 = normalizePath(path2);

    if (process.platform === "win32") {
        return path1.toLowerCase() === path2.toLowerCase();
    }
    return path1 === path2;
}

function normalizePath(p: string): string {
    let normalized = path.normalize(p);
    if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

export function getReadablePath(cwd: string, relPath?: string): string {
    relPath = relPath || "";
    const absolutePath = path.resolve(cwd, relPath);
    if (arePathsEqual(cwd, path.join(os.homedir(), "Desktop"))) {
        return absolutePath.toPosix();
    }
    if (arePathsEqual(path.normalize(absolutePath), path.normalize(cwd))) {
        return path.basename(absolutePath).toPosix();
    } else {
        const normalizedRelPath = path.relative(cwd, absolutePath);
        if (absolutePath.includes(cwd)) {
            return normalizedRelPath.toPosix();
        } else {
            return absolutePath.toPosix();
        }
    }
}
