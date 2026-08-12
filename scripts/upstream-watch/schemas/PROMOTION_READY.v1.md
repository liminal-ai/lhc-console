# PROMOTION_READY v1

Emitted by the **release qualifier** (or on their behalf) when Linux lifecycle
qualification has **passed** on exact candidate + smoke artifacts. Not a watch
report. Not authorization to publish.

## Exact field block

```
PROMOTION_READY v1
fork:                 codex-lhc | grok-build-lhc
repo:                 liminal-ai/codex-lhc | liminal-ai/grok-build-lhc
product_version:      <SemVer without v>
source_sha:           <full 40-char candidate_sha / origin/lhc tip qualified>
upstream_base:        <public-git base; Grok: patches/BASE>
source_rev:           <Grok SOURCE_REV monorepo id | none>
lhc_sdk_pin:          <vendor submodule sha>
candidate_run_id:     <GitHub Actions run id>
candidate_artifact_id: <artifact id>
candidate_digest:     sha256:<hex>
smoke_run_id:         <GitHub Actions run id>
qualification_artifact_id: <artifact id>
qualification_digest: sha256:<hex>
schema:               <thread/schema version if known | none>
produced_by:          codex-fork-steward | upstream-owner
produced_at:          <ISO-8601 UTC>
approval_status:      pending | approved | rejected
approval_id:          <stable id for this package; see promotion_ready.py>
```

## Rules

1. **Promotion** of these exact bytes requires **Lee or CTO** approval correlated
   to `approval_id` (and matching digests). No other identity may substitute.
2. Qualifier must resume promote with **same** `candidate_run_id`, digests, and
   `source_sha` — **no rebuild**.
3. Duplicate or late approval for a **different** digest must not promote.
4. CTO may notify Lee asynchronously; Lee need not sit in the qualify loop.
