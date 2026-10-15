"""Image extraction for embedded images in Office documents and PDFs.

Used by the indexer's image-embedding pipeline to surface every image
inside PPTX / PDF / DOCX / XLSX (and standalone .jpg/.jpeg/.png) so they
can be captioned and folded into the searchable text content.

Each extracted image is written to a workspace-scoped scratch directory
(``<workspace>/image_cache/<doc_sha1>/...``) so subsequent steps
(captioning, on-disk debugging, search-result preview) can address it by
path rather than carrying raw bytes through the pipeline. Caching is
keyed by the source-file SHA-1; re-indexing the same document re-uses
the cache and skips extraction on the fast path.

Output schema: ``ExtractedImage`` dataclass with ``page`` (1-indexed,
slide/sheet number or PDF page), ``index_in_page`` (multiple images per
page possible), ``path`` (cache location), and ``suffix`` (lowercase
extension like ``.png``).
"""

from __future__ import annotations

import hashlib
import io
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional, Tuple


@dataclass
class ExtractedImage:
    page: int
    index_in_page: int
    path: str
    suffix: str
    # Optional bytes — populated only when caller passes ``keep_bytes=True``.
    # Kept off by default to avoid doubling memory pressure for large decks.
    bytes_data: Optional[bytes] = field(default=None, repr=False)


# Use SHA-256 (truncated to 32 hex chars = 128 bits) instead of SHA-1 to
# avoid path-collision corner cases for adversarially named source files.
# The hash is derived from the absolute source path so re-indexing a doc
# reuses the same cache subdir.
_HASH_BITS = 32


def _doc_cache_dir(workspace: str, source_path: str) -> Path:
    h = hashlib.sha256(source_path.encode("utf-8")).hexdigest()[:_HASH_BITS]
    out = Path(workspace) / "image_cache" / h
    out.mkdir(parents=True, exist_ok=True)
    return out


# Extension allowlist for the cached image files. Parsers (PyMuPDF, pptx,
# openpyxl) report the original ext, but a malformed file could claim an
# arbitrary extension. Constrain to known image types so a corrupted ext
# can never end up writing `p0001_i00.exe` into the cache.
_ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}


def _write_image_bytes(
    cache_dir: Path,
    page: int,
    index: int,
    data: bytes,
    suffix: str,
) -> ExtractedImage:
    # Normalise suffix and pre-encode a deterministic filename so re-runs
    # against the same source produce stable paths (helpful when the
    # caller diffs extraction output across runs).
    suf = (suffix or "").lower()
    if not suf.startswith("."):
        suf = "." + suf
    if suf not in _ALLOWED_SUFFIXES:
        suf = ".png"  # fall through to a safe default rather than dropping the image
    name = f"p{page:04d}_i{index:02d}{suf}"
    path = cache_dir / name
    # Containment check: resolve and confirm the destination is still
    # inside cache_dir. This is defence-in-depth against an extractor
    # that ever decides to inject `..` into the path (none does today,
    # but a future parser might).
    resolved = path.resolve()
    cache_resolved = cache_dir.resolve()
    try:
        resolved.relative_to(cache_resolved)
    except ValueError as exc:
        raise ValueError(f"image path escapes cache_dir: {resolved}") from exc
    if not path.exists() or path.stat().st_size != len(data):
        path.write_bytes(data)
    return ExtractedImage(
        page=page,
        index_in_page=index,
        path=str(path),
        suffix=suf,
    )


# ── PPTX ───────────────────────────────────────────────────────────
def _extract_pptx(path: str, cache_dir: Path) -> List[ExtractedImage]:
    """zipfile로 PPTX 안 이미지를 슬라이드별로 추출 (stdlib only).

    PPTX의 각 슬라이드는 ``ppt/slides/_rels/slideN.xml.rels`` 에 자신이 참조
    하는 이미지를 선언한다. rel의 Target을 slide 디렉토리 기준으로 해석해
    ZIP 안에서 실제 바이너리를 읽는다. python-pptx 의존성을 피해 wheel
    추출이 사내 EDR에 차단되는 환경에서도 동작한다.

    같은 이미지가 한 슬라이드에서 여러 shape에 재사용되면 python-pptx는
    중복 dump 하지만 이 구현은 rels 단위라 1회만 dump 한다 — caption 비용
    측면에서 오히려 바람직한 동작이다.
    """
    import re
    import zipfile
    from posixpath import normpath
    from xml.etree import ElementTree as ET

    PR_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
    REL_TAG = f"{{{PR_NS}}}Relationship"
    rels_re = re.compile(r"^ppt/slides/_rels/slide(\d+)\.xml\.rels$")

    out: List[ExtractedImage] = []
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        indexed: List[Tuple[int, str]] = []
        for name in names:
            m = rels_re.match(name)
            if m:
                indexed.append((int(m.group(1)), name))
        indexed.sort(key=lambda x: x[0])

        for slide_idx, (_, rels_name) in enumerate(indexed, start=1):
            with zf.open(rels_name) as src:
                tree = ET.parse(src)
            idx_in_slide = 0
            for rel in tree.iter(REL_TAG):
                if not rel.get("Type", "").endswith("/image"):
                    continue
                target = rel.get("Target", "")
                if not target:
                    continue
                # rels Target은 slide 디렉토리 기준 상대경로 (e.g. "../media/img.png").
                # ZIP 내부는 항상 '/' 구분자라 posixpath로 정규화한다.
                target_path = normpath("ppt/slides/" + target)
                if target_path not in names:
                    continue
                try:
                    blob = zf.read(target_path)
                except KeyError:
                    continue
                if not blob:
                    continue
                suffix = Path(target_path).suffix.lower() or ".png"
                out.append(
                    _write_image_bytes(cache_dir, slide_idx, idx_in_slide, blob, suffix)
                )
                idx_in_slide += 1
    return out


# ── PDF ────────────────────────────────────────────────────────────
def _extract_pdf(path: str, cache_dir: Path) -> List[ExtractedImage]:
    """Use PyMuPDF (already a project dep) to dump every embedded image.

    We use ``page.get_images(full=True)`` + ``Document.extract_image(xref)``
    so re-used images (the same xref referenced on multiple pages) are
    decoded once per page they appear on — matching the captioning
    granularity expected by search.
    """
    import pymupdf  # type: ignore

    out: List[ExtractedImage] = []
    with pymupdf.open(path) as doc:
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            images = page.get_images(full=True)
            for idx, info in enumerate(images):
                xref = info[0]
                try:
                    data = doc.extract_image(xref)
                except Exception:
                    continue
                blob = data.get("image")
                ext = (data.get("ext") or "png").lower()
                if not blob:
                    continue
                out.append(
                    _write_image_bytes(cache_dir, page_num + 1, idx, blob, ext)
                )
    return out


# ── DOCX ───────────────────────────────────────────────────────────
def _extract_docx(path: str, cache_dir: Path) -> List[ExtractedImage]:
    """DOCX is a ZIP; every embedded image lives under ``word/media/``.
    We dump each entry directly via stdlib zipfile, bypassing python-docx
    so the plugin avoids a wheel whose extraction can be blocked by
    endpoint security on locked-down corporate machines.

    DOCX has no real page concept, so all images land on page=1 (mirrors
    the docx text parser's single-page output). Names are sorted so
    output ordering is deterministic across runs."""
    import zipfile

    out: List[ExtractedImage] = []
    idx = 0
    with zipfile.ZipFile(path) as zf:
        for name in sorted(zf.namelist()):
            if not name.startswith("word/media/") or name.endswith("/"):
                continue
            blob = zf.read(name)
            if not blob:
                continue
            suffix = Path(name).suffix.lower() or ".png"
            out.append(_write_image_bytes(cache_dir, 1, idx, blob, suffix))
            idx += 1
    return out


# ── XLSX ───────────────────────────────────────────────────────────
def _extract_xlsx(path: str, cache_dir: Path) -> List[ExtractedImage]:
    """openpyxl tracks images per-worksheet on ``ws._images``. Each entry
    is an ``OpenpyxlImage`` whose underlying PIL ``Image`` we re-encode
    to PNG so the captioner has a predictable format."""
    import openpyxl  # type: ignore

    out: List[ExtractedImage] = []
    wb = openpyxl.load_workbook(path, data_only=True)
    for sheet_idx, name in enumerate(wb.sheetnames, start=1):
        ws = wb[name]
        for img_idx, image in enumerate(getattr(ws, "_images", []) or []):
            try:
                buf = io.BytesIO()
                pil = image.image if hasattr(image, "image") else None
                if pil is None:
                    continue
                pil.save(buf, format="PNG")
                blob = buf.getvalue()
            except Exception:
                continue
            out.append(_write_image_bytes(cache_dir, sheet_idx, img_idx, blob, ".png"))
    return out


# ── standalone image ───────────────────────────────────────────────
def _extract_standalone(path: str, cache_dir: Path) -> List[ExtractedImage]:
    """Single image file: copy-by-reference into the cache so the
    downstream caption path treats it identically to extracted images.
    """
    src = Path(path)
    suffix = src.suffix.lower() or ".png"
    # Reuse the original file path — no need to duplicate; the captioner
    # accepts any readable path. Wrap it in the same dataclass for API
    # uniformity.
    return [
        ExtractedImage(page=1, index_in_page=0, path=str(src), suffix=suffix),
    ]


# ── Public dispatch ────────────────────────────────────────────────
def extract_images(path: str, doc_type: str, workspace: str) -> List[ExtractedImage]:
    """Return every image associated with ``path``.

    ``doc_type`` is the same shorthand used by the indexer
    (``pdf``/``pptx``/``docx``/``xlsx``/``image``). Unknown / unsupported
    types return an empty list so callers can unconditionally call this
    function and skip the captioning loop when nothing comes back.
    """
    if not os.path.isfile(path):
        return []
    cache_dir = _doc_cache_dir(workspace, path)
    try:
        if doc_type == "pptx":
            return _extract_pptx(path, cache_dir)
        if doc_type == "pdf":
            return _extract_pdf(path, cache_dir)
        if doc_type == "docx":
            return _extract_docx(path, cache_dir)
        if doc_type == "xlsx":
            return _extract_xlsx(path, cache_dir)
        if doc_type == "image":
            return _extract_standalone(path, cache_dir)
    except Exception:
        # Extraction failures are best-effort — we never want a corrupt
        # image-bearing doc to fail the whole indexing pass. The caller
        # logs and proceeds with text-only indexing.
        return []
    return []
