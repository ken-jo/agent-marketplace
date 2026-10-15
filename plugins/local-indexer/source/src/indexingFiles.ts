import { basename, extname } from "node:path";
import type { IndexMode } from "./types.js";

// Office lock files (Word ~$, LibreOffice .~lock.) — never index these
export const TEMP_FILE_PREFIXES = ["~$", ".~lock."];

export const SUPPORTED_INDEX_EXTENSIONS = [
  ".pdf",
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".docx",
  ".pptx",
  ".xlsx",
] as const;

// Image-only extensions — gated behind the image-embedding toggle. When the
// toggle is off these files are silently skipped (legacy behaviour); when it
// is on they are routed through the captioning pipeline (caption → text
// embedding) instead of the regular text parsers.
export const IMAGE_INDEX_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;

const MODE_BY_EXTENSION: Record<string, IndexMode> = {
  ".pdf": "pdf",
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
  ".html": "html",
  ".htm": "html",
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
};

const IMAGE_MODE_BY_EXTENSION: Record<string, IndexMode> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
};

const SUPPORTED_INDEX_EXTENSION_SET = new Set<string>(SUPPORTED_INDEX_EXTENSIONS);
const IMAGE_INDEX_EXTENSION_SET = new Set<string>(IMAGE_INDEX_EXTENSIONS);

export function isIndexableFilePath(
  filePath: string,
  options?: { includeImages?: boolean },
): boolean {
  const name = basename(filePath);
  if (TEMP_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  const ext = extname(filePath).toLowerCase();
  if (SUPPORTED_INDEX_EXTENSION_SET.has(ext)) return true;
  if (options?.includeImages && IMAGE_INDEX_EXTENSION_SET.has(ext)) return true;
  return false;
}

export function getIndexModeForPath(
  filePath: string,
  options?: { includeImages?: boolean },
): IndexMode | null {
  const ext = extname(filePath).toLowerCase();
  const textMode = MODE_BY_EXTENSION[ext];
  if (textMode) return textMode;
  if (options?.includeImages) {
    const imageMode = IMAGE_MODE_BY_EXTENSION[ext];
    if (imageMode) return imageMode;
  }
  return null;
}

/** True if the extension is an image type (regardless of the toggle). */
export function isImageFilePath(filePath: string): boolean {
  return IMAGE_INDEX_EXTENSION_SET.has(extname(filePath).toLowerCase());
}
