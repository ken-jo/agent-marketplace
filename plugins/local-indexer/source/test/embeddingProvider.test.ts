import { describe, expect, it } from "vitest";
import { resolveEmbeddingProvider } from "../src/localIndexerPlugin.js";

// 본 PR 에서 default fallback 이 'local' → 'openai' 로 바뀐 이유:
// API 키가 없어도 worker 가 BM25-only 로 폴백하고, 첫 스캔에서 무거운
// sentence-transformers 로컬 모델 로드를 피한다 (클릭 latency 개선
// 트랙의 일부). 명시 모델/명시 provider 가 있으면 기존 우선순위를 유지.
describe("resolveEmbeddingProvider", () => {
  it("model + explicitProvider 모두 미지정 → default 'openai' (BM25 폴백 경로)", () => {
    expect(resolveEmbeddingProvider()).toBe("openai");
    expect(resolveEmbeddingProvider(undefined, undefined)).toBe("openai");
  });

  it("'text-embedding-3-small' → 'openai' 자동 감지", () => {
    expect(resolveEmbeddingProvider("text-embedding-3-small")).toBe("openai");
  });

  it("'text-embedding-3-large' → 'openai' 자동 감지", () => {
    expect(resolveEmbeddingProvider("text-embedding-3-large")).toBe("openai");
  });

  it("'text-embedding-ada-002' → 'openai' 자동 감지", () => {
    expect(resolveEmbeddingProvider("text-embedding-ada-002")).toBe("openai");
  });

  it("HuggingFace 모델명 → default fallback 따라 'openai'", () => {
    expect(resolveEmbeddingProvider("paraphrase-multilingual-MiniLM-L12-v2")).toBe("openai");
    expect(resolveEmbeddingProvider("BAAI/bge-m3")).toBe("openai");
  });

  it("explicitProvider='openai' → HF 모델이어도 'openai' (명시 우선)", () => {
    expect(resolveEmbeddingProvider("paraphrase-multilingual-MiniLM-L12-v2", "openai")).toBe("openai");
  });

  it("알 수 없는 explicitProvider → 무시하고 model 로 자동 감지, default 시 'openai'", () => {
    expect(resolveEmbeddingProvider("text-embedding-3-small", "unknown")).toBe("openai");
    // HF 모델이지만 default 가 openai 라 unknown explicit 도 openai 로 떨어짐.
    expect(resolveEmbeddingProvider("paraphrase-multilingual-MiniLM-L12-v2", "unknown")).toBe("openai");
  });

  it("대소문자 혼합 모델명도 openai 자동 감지 (case-insensitive)", () => {
    expect(resolveEmbeddingProvider("Text-Embedding-3-Small")).toBe("openai");
    expect(resolveEmbeddingProvider("TEXT-EMBEDDING-ADA-002")).toBe("openai");
    expect(resolveEmbeddingProvider("Text-Embedding-3-Large")).toBe("openai");
  });

  it("빈 문자열 model → default 'openai'", () => {
    expect(resolveEmbeddingProvider("")).toBe("openai");
    expect(resolveEmbeddingProvider("", undefined)).toBe("openai");
  });

  it("빈 문자열 explicitProvider → model 로 자동 감지, default 'openai'", () => {
    expect(resolveEmbeddingProvider("text-embedding-3-small", "")).toBe("openai");
    expect(resolveEmbeddingProvider("paraphrase-multilingual-MiniLM-L12-v2", "")).toBe("openai");
  });

  // #955: host vendor inherit. Azure-only 사용자가 plugin default "openai"
  // 때문에 OpenAI public 호출 → 회사망 cert 차단되는 버그를 막기 위함.
  describe("hostVendor inherit (#955)", () => {
    it("hostVendor='azure-foundry' + 미명시 → 'azure' (host vendor inherit)", () => {
      expect(resolveEmbeddingProvider(undefined, undefined, "azure-foundry")).toBe("azure");
    });

    it("hostVendor='azure-openai' + 미명시 → 'azure' (host vendor inherit)", () => {
      expect(resolveEmbeddingProvider(undefined, undefined, "azure-openai")).toBe("azure");
    });

    it("hostVendor='Azure' (대문자) → 'azure' (case-insensitive match)", () => {
      expect(resolveEmbeddingProvider(undefined, undefined, "Azure")).toBe("azure");
    });

    it("hostVendor='openai' + 미명시 → 'openai' (기본 유지)", () => {
      expect(resolveEmbeddingProvider(undefined, undefined, "openai")).toBe("openai");
    });

    it("hostVendor='claude' + 미명시 → 'openai' (azure 가 아니면 inherit 안 함)", () => {
      expect(resolveEmbeddingProvider(undefined, undefined, "claude")).toBe("openai");
    });

    it("hostVendor='azure-foundry' 라도 explicitProvider='openai' 명시 → 'openai' (명시 우선)", () => {
      expect(resolveEmbeddingProvider(undefined, "openai", "azure-foundry")).toBe("openai");
    });

    it("hostVendor='azure-foundry' + model='text-embedding-3-small' → 'openai' (model prefix 가 hostVendor 보다 우선)", () => {
      expect(resolveEmbeddingProvider("text-embedding-3-small", undefined, "azure-foundry")).toBe(
        "openai",
      );
    });

    it("hostVendor=undefined / '' / 미전달 → 기존 default 'openai' 유지 (역호환)", () => {
      expect(resolveEmbeddingProvider(undefined, undefined, undefined)).toBe("openai");
      expect(resolveEmbeddingProvider(undefined, undefined, "")).toBe("openai");
    });
  });
});
