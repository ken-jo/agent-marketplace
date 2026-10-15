# Retrieval Eval (`eval/`)

This directory is the **source of truth (SoT)** for retrieval quality in the
Ave Local Indexer. Every change that can affect ranking — tokenizer, chunking,
BM25/FTS5 config, RRF weights, embedding model, the hybrid fusion — is validated
here. It runs the **real** hybrid search path
(`SearchService.search_hybrid_internal`: RRF + FTS5 + Kiwi) over a fixed golden
set.

## ⚠️ Two gates — do not confuse them

There are **two** evals here, measuring **different** things:

| Gate | Embedder | Runs | Measures | Source-of-truth for |
|------|----------|------|----------|---------------------|
| **PR lexical guard** (`../test/retrieval_eval.test.py`, workflow `retrieval-eval.yml`) | `DeterministicEmbedder` (offline, no key) | every PR/push | the **LEXICAL** path only (Kiwi + FTS5 + RRF) | Kiwi-tokenizer / FTS5-index / RRF-fusion regressions |
| **Nightly real-embedding eval** (`run_eval.py` with `EVAL_EMBEDDING_ENDPOINT`, workflow `retrieval-eval-real.yml`) | real `OpenAIEmbeddingClient` (needs an API-key secret) | nightly + manual | **real embedding / reranker / OCR** quality | embedding / reranker / OCR model decisions |

**The PR lexical guard's Recall@10 / nDCG@10 say NOTHING about embedding
quality.** It uses a fake char-trigram embedder, so a better embedding model is
invisible to it. Citing its baseline as an embedding-quality number is the exact
over-claim caught in P1 #187 — don't. Use the **nightly real-embedding eval** for
any embedding / reranker / OCR comparison.

## What's here

| File | Role |
|------|------|
| `corpus/` | 117 small, topically-distinct KO/EN policy docs (`.md`) + 1 OCR-target text fixture (`.txt`). Docs are grouped into vocabulary **clusters** (휴가, 급여, IT보안, 개인정보, 구매, 재무, 안전, 인사, 품질, 영업, IT운영, 법무) so the lexical path cannot trivially top-rank the single gold doc — this de-ceilings the baseline. Stable filenames `ko-0NN-<topic>.md` / `en-0NN-<topic>.md`; the leading `ko-0NN` / `en-0NN` is the stable doc id. |
| `queries.json` | 43 graded queries (KO + EN), incl. paraphrastic queries whose gold doc is **not** the trivial top lexical hit. Each: `{ id, query, lang, relevant: [{ doc, grade }] }`, grade 0–3. |
| `embedder.py` | `DeterministicEmbedder` — offline, hashed char-trigram BoW → 256-dim L2-normalized vectors. Byte-identical across runs, **no network, no API key**. Stands in for the cloud embedding client on the PR lexical guard so CI is hermetic. **It does not measure embedding quality.** |
| `vector_store.py` | `InMemoryCosineStore` — duck-typed LanceDB stand-in. Score = `1 / (1 + cosine_distance)`, mirroring production polarity. |
| `metrics.py` | Pure `recall_at_k` / `ndcg_at_k`. |
| `run_eval.py` | Indexes the corpus through the real `LocalIndexer` (DI-injected embedder + store + Kiwi), runs every query through the real hybrid path, computes Recall@10 / nDCG@10 / per-query latency, writes `last_run.json`. `build_embedder()` selects the embedder from the environment (deterministic by default; real cloud client when `EVAL_EMBEDDING_ENDPOINT` is set). |
| `baseline.json` | The recorded **lexical** baseline the PR guard ratchets against. |
| `last_run.json` | Generated artifact (git-ignored); uploaded by CI. |

## Why a deterministic offline embedder (on the PR guard)

The PR guard must be **hermetic**: no embedding API key, no network egress, and
byte-identical results on every machine and every run, so the baseline is
reproducible and a red gate always means a real **lexical** regression.
`DeterministicEmbedder` hashes character trigrams into a fixed 256-dim vector —
same input → same bytes. It is **not** a production fallback (it lives only under
`eval/`, is never imported by the worker, and its file header says so): production
embeddings come from the real cloud client, and the **nightly** eval measures
*those*.

## Running the REAL-embedding eval locally

To measure genuine embedding quality (the data that drives model decisions), set
the env hook and run `run_eval.py` directly — `EVAL_EMBEDDING_ENDPOINT` flips it
from the deterministic embedder to the real `OpenAIEmbeddingClient`:

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv -r python-requirements.lock

export EVAL_EMBEDDING_ENDPOINT="https://api.openai.com/v1"
export EVAL_EMBEDDING_API_KEY="sk-..."            # your key — never commit it
export EVAL_EMBEDDING_MODEL="text-embedding-3-small"   # optional override
# export EVAL_EMBEDDING_DIMENSIONS="1536"          # optional override

.venv/bin/python eval/run_eval.py
# -> embedder=real:openai:text-embedding-3-small corpus=118 queries=43 recall@10=... ndcg@10=...
```

This makes real network calls and costs money. To compare candidates, re-run
with a different `EVAL_EMBEDDING_MODEL` (e.g. `text-embedding-3-large`) and diff
the Recall@10 / nDCG@10. Do **not** point the PR guard at a real endpoint — it
injects the deterministic embedder explicitly and ignores `EVAL_EMBEDDING_*`.

## Nightly CI needs a secret (one-time maintainer setup)

The nightly real-embedding job (`../.github/workflows/retrieval-eval-real.yml`)
needs an API key to run. A maintainer must add a repo secret
**`EVAL_EMBEDDING_API_KEY`** (or `OPENAI_API_KEY`) under
*Settings → Secrets and variables → Actions*. Without it the job **skips
gracefully** (green, no measurement). Optional repo *variables*:
`EVAL_EMBEDDING_ENDPOINT` (default `https://api.openai.com/v1`),
`EVAL_EMBEDDING_MODEL` (default `text-embedding-3-small`).

## Why Kiwi is a hard requirement (not `importorskip`)

The corpus is Korean-heavy and the gate exists to protect the Korean morpheme
path. `test/retrieval_eval.test.py` does `import kiwipiepy` **directly** at module
top. If Kiwi were missing, `pytest.importorskip` would *skip* the test and the
gate would report green while measuring nothing — a silently falsely-passing
gate. A missing Kiwi must hard-fail the build instead.

## Baseline-ratchet policy (PR lexical guard)

The PR guard enforces three things against `baseline.json` (a **lexical**
baseline — recall ~0.76 / nDCG ~0.71, intentionally **not** ceiling-saturated so
the nightly real-embedding run has measurable headroom):

1. **Regression guard** — `recall@10 >= baseline - 0.02` and
   `ndcg@10 >= baseline - 0.02`.
2. **Absolute floor** — `recall@10 >= 0.60` and `ndcg@10 >= 0.55`, independent of
   the baseline (catches a catastrophic regression that a re-baselined PR could
   otherwise slip through).
3. **Latency** — p95 under an absolute hard ceiling (2.0s) plus a headroom-padded
   2× regression bound.

Ratchet rules:

- A change that **raises** Recall@10 / nDCG@10 **updates `baseline.json` in the
  same PR** to lock in the gain.
- The baseline is **never lowered without explicit sign-off** documented in the
  PR description (a legitimate corpus expansion that changes the achievable
  ceiling is the only normal reason).
- Re-baselining and corpus/query edits land together with the eval output so a
  reviewer can see the new numbers.

## How to add a query

1. Pick the relevant doc id(s) from `corpus/` (e.g. `ko-014`).
2. Append an entry to `queries.json` with a unique `id`, the `query`, its `lang`,
   and graded `relevant` judgments (grade 3 = ideal answer, 1 = weakly related).
3. Run `python eval/run_eval.py` and confirm the numbers are sane.
4. If the aggregate moved up, update `baseline.json` in the same PR.

## How to add a doc

1. Create `corpus/<ko|en>-0NN-<topic>.md` with a new sequential id. Keep it
   small, topically distinct, and self-contained. `.md`/`.txt` only — no binaries.
   To preserve the de-ceiling property, place the doc in (or near) an existing
   vocabulary cluster so the lexical path has to discriminate.
2. Add or update the `queries.json` judgments that should reference it.
3. Re-run and re-baseline (up only) as above.

## OCR-target fixture

`corpus/ko-108-scanned-expense-receipt-ocr.txt` is a **plain-text fixture that
represents the OCR transcript of a scanned Korean receipt**. It lets the OCR
recall path be measured end-to-end once OCR lands (a query — `q-ko-36` — already
targets it through the same hybrid path). When a real scanned-PDF → OCR pipeline
exists, swap this fixture for the actual OCR output of a real low-DPI scan to
measure OCR precision against the same metrics.

## Running locally

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv -r python-requirements.lock

# PR LEXICAL guard (deterministic, no key) — the per-PR regression gate:
.venv/bin/python eval/run_eval.py                       # prints summary, writes last_run.json
.venv/bin/python -m pytest test/retrieval_eval.test.py  # the gate

# REAL-embedding eval (needs a key) — see "Running the REAL-embedding eval
# locally" above for the EVAL_EMBEDDING_* env vars.
```

## Ownership

The eval set (corpus + relevance judgments) is owned by the Local Indexer
maintainers. Relevance grades are authored by hand; treat them as the
specification of "good retrieval" for this plugin.
