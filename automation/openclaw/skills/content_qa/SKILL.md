---
name: content_qa
version: 1.0.0
description: >
  Guardrail + plagiarism check for marketing drafts. Runs platform-specific
  policy rules, a banned-terms list, optional Originality.ai plagiarism
  scoring, and returns a structured verdict consumed by the n8n fan-out
  workflow (node "content_qa (OpenClaw)").
inputs:
  - { name: platform, type: string, required: true, enum: [facebook, zalo_oa, tiktok, linkedin] }
  - { name: body,     type: string, required: true }
  - { name: topic,    type: string, required: false }
  - { name: hashtags, type: array,  required: false }
outputs:
  - name: policyOk
    type: boolean
  - name: plagiarism
    type: number
    description: Similarity score 0..1 from Originality.ai (0 when check skipped).
  - name: risk
    type: string
    enum: [low, medium, high]
  - name: violations
    type: array
    description: Array of rule IDs triggered.
  - name: notes
    type: string
requirements:
  tools:
    - http.request
    - fs.read
limits:
  concurrency: 4
  timeout_seconds: 30
---

# Skill — `content_qa`

## Rule sources (read once, cached)

1. `rules/banned_terms.vi.txt`  — thương hiệu cấm, từ nhạy cảm, competitor.
2. `rules/platform_limits.json` — max length, max hashtags, disallowed formats.
3. `rules/claims_whitelist.txt` — các tuyên bố được phép (ví dụ "giảm 20%"
   chỉ hợp lệ nếu trong whitelist).

## Pipeline

1. **Normalize** `body` to NFKC, lowercase for matching (keep original for return).
2. **Platform limits**
   - `facebook`: `len(body) ≤ 5000`, `hashtags ≤ 5`.
   - `zalo_oa`:  `len(body) ≤ 500`, no URLs containing `bit.ly|tinyurl|cutt.ly`.
   - `tiktok`:   `len(body) ≤ 150`, `hashtags ≤ 8`.
   - `linkedin`: `len(body) ≤ 1500`, `hashtags ≤ 3`.
   Fail → add rule `PLATFORM_LIMIT`, risk = high.
3. **Banned-terms scan**
   - Substring match against banned list. Hit → `BANNED_TERM`, risk = high.
4. **Claim validation**
   - Regex `((\\d{1,3})\\s*%|\\d+\\s*(nghìn|triệu|tỷ))` — mỗi khớp phải xuất
     hiện trong `topic` hoặc `claims_whitelist`; nếu không → `UNVERIFIED_CLAIM`,
     risk = medium.
5. **Plagiarism (optional)**
   - If `ORIGINALITY_API_KEY` is set, POST body to
     `https://api.originality.ai/api/v1/scan/ai` with timeout 10 s.
   - `score_original < 0.6` → `PLAGIARISM`, risk = medium.
   - On HTTP error or missing key → `plagiarism = 0`, no violation.
6. **Aggregate**
   - `policyOk = violations has no high-risk rule`.
   - `risk = max(level) across violations`, default `low`.

## Output contract

```json
{
  "policyOk": true,
  "plagiarism": 0.08,
  "risk": "low",
  "violations": [],
  "notes": "banned=0; claims_ok=2; originality=0.92"
}
```

## Wiring

- Called from n8n workflow `06-content-fanout` node **`content_qa (OpenClaw)`**.
- Request body schema: `{ platform, body, topic }`. Extend with `hashtags`
  when editorial requests richer validation.
- Non-200 from OpenClaw → n8n continues via `onError: continueErrorOutput`;
  `Shape draft + QA` falls back to `{ policyOk: true, risk: 'low', notes: 'qa_skipped' }`.

## Failure modes

| Symptom                         | Behaviour                                             |
| ------------------------------- | ----------------------------------------------------- |
| Originality.ai timeout / 5xx    | Mark plagiarism = 0, add note `plagiarism_skipped`    |
| Rules file missing              | Return `policyOk=false, risk=high, note=rules_missing` |
| Input too long (> 10 KB)        | Return `policyOk=false, risk=high, note=input_too_big` |

## Maintenance

- Rules live in `automation/openclaw/skills/content_qa/rules/`. Review weekly
  during editorial sync. Commit changes to git so rollback is trivial.
