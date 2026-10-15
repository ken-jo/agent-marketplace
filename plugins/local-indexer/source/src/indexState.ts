/**
 * IndexState — ~/.ave/local-indexer/index-state.json 관리
 *
 * 인덱싱된 파일 상태를 영속화하여 stale/orphan 감지에 활용.
 * atomic write (temp + rename) 사용.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── 타입 ────────────────────────────────────────────

export interface IndexEntry {
  docId: string;
  mtimeMs: number;
  chunkHash: string;
  indexedAt: string;
}

export interface IndexedFileEntry extends IndexEntry {
  filePath: string;
}

interface IndexStateFile {
  version: 1;
  entries: Record<string, IndexEntry>;
}

// ─── IndexState ──────────────────────────────────────

export class IndexState {
  private readonly statePath: string;
  private entries: Map<string, IndexEntry> = new Map();
  private loaded = false;

  /**
   * @param statePath REQUIRED, and it used to have a `homedir()`-rooted
   * default. Every caller already passed a path, so the default was reach
   * nobody used — and it was reach of the worst kind: `homedir()` answers with
   * whatever HOME the process was given, which for a confined child is a
   * throwaway the host deletes on exit. A state file written there would be
   * neither refused nor durable, so the failure would have looked like success
   * and shown up as an index that silently re-scanned everything each start.
   */
  constructor(statePath: string) {
    this.statePath = statePath;
  }

  // ─── Public API ───────────────────────────────────

  /** 파일 경로, docId, mtime, chunkHash를 등록/갱신 */
  async addEntry(filePath: string, docId: string, mtimeMs: number, chunkHash: string): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(filePath, {
      docId,
      mtimeMs,
      chunkHash,
      indexedAt: new Date().toISOString(),
    });
    await this.save();
  }

  /** 경로로 항목 조회. 없으면 undefined */
  async getEntry(filePath: string): Promise<IndexEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.get(filePath);
  }

  /**
   * stale 항목 탐지.
   * currentMtimes: 현재 디스크의 { filePath → mtimeMs } 맵.
   * 상태 파일에는 있으나 mtime이 변경된 경로 목록 반환.
   */
  async findStale(currentMtimes: Map<string, number>): Promise<string[]> {
    await this.ensureLoaded();
    const stale: string[] = [];
    for (const [filePath, entry] of this.entries) {
      const currentMtime = currentMtimes.get(filePath);
      if (currentMtime !== undefined && currentMtime > entry.mtimeMs) {
        stale.push(filePath);
      }
    }
    return stale;
  }

  /**
   * orphan 항목 탐지.
   * existingPaths: 현재 디스크에 실재하는 파일 경로 집합.
   * 상태 파일에는 있으나 디스크에 없는 경로 목록 반환.
   */
  async findOrphans(existingPaths: Set<string>): Promise<string[]> {
    await this.ensureLoaded();
    const orphans: string[] = [];
    for (const filePath of this.entries.keys()) {
      if (!existingPaths.has(filePath)) {
        orphans.push(filePath);
      }
    }
    return orphans;
  }

  /** 항목 삭제 */
  async removeEntry(filePath: string): Promise<void> {
    await this.ensureLoaded();
    if (this.entries.delete(filePath)) {
      await this.save();
    }
  }

  /** 여러 항목을 한 번에 삭제하고 disk write 1회로 처리 */
  async removeEntries(filePaths: string[]): Promise<number> {
    await this.ensureLoaded();
    let removed = 0;
    for (const filePath of filePaths) {
      if (this.entries.delete(filePath)) removed += 1;
    }
    if (removed > 0) await this.save();
    return removed;
  }

  /** 전체 항목 수 */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.size;
  }

  /** 전체 항목 목록 */
  async listEntries(): Promise<IndexedFileEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.entries()].map(([filePath, entry]) => ({
      filePath,
      ...entry,
    }));
  }

  // ─── Private ──────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.load();
    this.loaded = true;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<IndexStateFile>;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v && typeof v === "object" && "docId" in v) {
            this.entries.set(k, v as IndexEntry);
          }
        }
      }
    } catch (err) {
      const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        console.warn(`[IndexState] Failed to load state file (${this.statePath}), starting fresh:`, err);
      }
      this.entries = new Map();
    }
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.statePath);
    await fs.mkdir(dir, { recursive: true });

    const data: IndexStateFile = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    const json = JSON.stringify(data, null, 2);

    // atomic write: temp 파일에 쓰고 rename
    const tmpPath = `${this.statePath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, json, "utf8");
    await fs.rename(tmpPath, this.statePath);
  }
}
