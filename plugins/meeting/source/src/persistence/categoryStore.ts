import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSessionCategory } from "./sessionMetadata.js";

const FILE_NAME = "categories.json";

export const BUILT_IN_CATEGORIES = [
  "일반",
  "프로젝트",
  "정기회의",
  "1:1",
  "고객/외부",
  "의사결정",
  "회고",
];

export class CategoryStore {
  private readonly path: string;
  private cache: string[] | null = null;

  constructor(storageDir: string) {
    mkdirSync(storageDir, { recursive: true });
    this.path = join(storageDir, FILE_NAME);
  }

  list(extra: unknown[] = []): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...BUILT_IN_CATEGORIES, ...this.read(), ...extra]) {
      const category = normalizeSessionCategory(raw);
      if (seen.has(category)) continue;
      seen.add(category);
      out.push(category);
    }
    return out;
  }

  has(raw: unknown, extra: unknown[] = []): boolean {
    if (typeof raw !== "string" || raw.trim().length === 0) return false;
    const category = normalizeSessionCategory(raw);
    return this.list(extra).includes(category);
  }

  register(raw: unknown): string {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error("category is required");
    }
    const category = normalizeSessionCategory(raw);
    const current = this.list();
    if (!current.includes(category)) {
      this.write([...current, category]);
    }
    return category;
  }

  private read(): string[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as { categories?: unknown };
      this.cache = Array.isArray(parsed.categories)
        ? parsed.categories.map(normalizeSessionCategory)
        : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private write(categories: string[]): void {
    const normalized = categories
      .map(normalizeSessionCategory)
      .filter((category, index, arr) => arr.indexOf(category) === index);
    this.cache = normalized;
    const tmpPath = `${this.path}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify({ categories: normalized }, null, 2), "utf-8");
      renameSync(tmpPath, this.path);
    } catch (err) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* noop */ }
      throw err;
    }
  }
}
