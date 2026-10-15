import { describe, expect, it } from "vitest";
import {
  getIndexModeForPath,
  isImageFilePath,
  isIndexableFilePath,
  TEMP_FILE_PREFIXES,
} from "../src/indexingFiles";

describe("isIndexableFilePath", () => {
  it("Office 임시 파일(~$)을 거부한다", () => {
    expect(isIndexableFilePath("/docs/~$foo.docx")).toBe(false);
    expect(isIndexableFilePath("/docs/~$report.xlsx")).toBe(false);
    expect(isIndexableFilePath("/docs/~$slide.pptx")).toBe(false);
  });

  it("LibreOffice 락 파일(.~lock.)을 거부한다", () => {
    expect(isIndexableFilePath("/docs/.~lock.bar.odt#")).toBe(false);
    expect(isIndexableFilePath("/docs/.~lock.document.docx#")).toBe(false);
  });

  it("지원 확장자 파일을 허용한다", () => {
    expect(isIndexableFilePath("/docs/report.docx")).toBe(true);
    expect(isIndexableFilePath("/docs/slide.pptx")).toBe(true);
    expect(isIndexableFilePath("/docs/data.xlsx")).toBe(true);
    expect(isIndexableFilePath("/docs/readme.md")).toBe(true);
    expect(isIndexableFilePath("/docs/notes.txt")).toBe(true);
    expect(isIndexableFilePath("/docs/page.html")).toBe(true);
    expect(isIndexableFilePath("/docs/manual.pdf")).toBe(true);
  });

  it("기본값(이미지 임베딩 꺼짐)에서는 이미지 확장자를 거부한다", () => {
    expect(isIndexableFilePath("/docs/image.png")).toBe(false);
    expect(isIndexableFilePath("/docs/photo.jpg")).toBe(false);
    expect(isIndexableFilePath("/docs/photo.jpeg")).toBe(false);
    expect(isIndexableFilePath("/docs/archive.zip")).toBe(false);
    expect(isIndexableFilePath("/docs/script.js")).toBe(false);
  });

  it("includeImages=true 면 .jpg/.jpeg/.png 만 추가로 허용한다", () => {
    expect(isIndexableFilePath("/docs/image.png", { includeImages: true })).toBe(true);
    expect(isIndexableFilePath("/docs/photo.jpg", { includeImages: true })).toBe(true);
    expect(isIndexableFilePath("/docs/photo.jpeg", { includeImages: true })).toBe(true);
    // 임시 파일 규칙은 includeImages 와 무관하게 유지된다.
    expect(isIndexableFilePath("/docs/~$leaked.png", { includeImages: true })).toBe(false);
    // 여전히 zip / js 등은 막혀야 한다.
    expect(isIndexableFilePath("/docs/archive.zip", { includeImages: true })).toBe(false);
    expect(isIndexableFilePath("/docs/script.js", { includeImages: true })).toBe(false);
  });

  it("getIndexModeForPath 가 includeImages 옵션에 따라 image 모드를 노출한다", () => {
    expect(getIndexModeForPath("/docs/photo.jpg")).toBeNull();
    expect(getIndexModeForPath("/docs/photo.jpg", { includeImages: true })).toBe("image");
    expect(getIndexModeForPath("/docs/photo.png", { includeImages: true })).toBe("image");
    // 텍스트 확장자는 옵션과 무관하게 본래 모드 반환.
    expect(getIndexModeForPath("/docs/report.pdf")).toBe("pdf");
    expect(getIndexModeForPath("/docs/report.pdf", { includeImages: true })).toBe("pdf");
  });

  it("isImageFilePath 는 토글과 무관하게 이미지 확장자 여부를 보고한다", () => {
    expect(isImageFilePath("/docs/photo.jpg")).toBe(true);
    expect(isImageFilePath("/docs/photo.jpeg")).toBe(true);
    expect(isImageFilePath("/docs/photo.png")).toBe(true);
    expect(isImageFilePath("/docs/report.pdf")).toBe(false);
  });

  it("TEMP_FILE_PREFIXES가 export된다", () => {
    expect(TEMP_FILE_PREFIXES).toContain("~$");
    expect(TEMP_FILE_PREFIXES).toContain(".~lock.");
  });
});
