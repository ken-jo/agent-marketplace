/**
 * Host contract stubs — structural interfaces for host types that the
 * host's public contract (`@ave/plugin-contract`, vendored from Ave)
 * does not export yet.
 *
 * Keep these shapes in sync with the host-side sources of truth. When the
 * host adds them to its public contract, import them from there instead.
 */

import type { SearchHit } from "./types.js";

/** Structural mirror of host `WorkerSearchClient`. */
export interface WorkerSearchClient {
  searchBm25(query: string, topK: number): Promise<SearchHit[]>;
  searchVector(query: string, topK: number): Promise<SearchHit[]>;
}

/** Structural mirror of host `KnowledgeWorkerClient`. */
export interface KnowledgeWorkerClient {
  listDocuments(): Promise<
    Array<{
      docId: string;
      docName: string;
      type: string;
      pageCount?: number;
      updatedAt?: string;
    }>
  >;
  getStructure(docId: string): Promise<unknown>;
  getPageContent(
    docId: string,
    pages: string,
  ): Promise<Array<{ page: number; content: string }>>;
}
