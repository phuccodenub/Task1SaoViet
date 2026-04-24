---
title: "Codebase Hygiene Alignment Plan"
description: "Kế hoạch xử lý 4 vấn đề nền tảng: docs/package drift, Node version enforcement, baseline test/lint tooling, JWT dependency cleanup."
status: pending
priority: P1
effort: 6h
branch: main
tags: [maintenance, tooling, docs, node, lint, test, jwt]
created: 2026-04-19
blockedBy: []
blocks: []
---

## Scope
Chuẩn hóa các guardrail nền tảng của repo để giảm drift, giảm lỗi môi trường, và tạo baseline kiểm tra tối thiểu trước khi mở rộng tiếp.

## Why now
- README đang lệch thực tế dependency (Vuetify 3 vs repo dùng 4.0.4)
- Node 20 chỉ được nói trong README/Docker, chưa enforce cho local dev
- Cả backend/frontend chưa có baseline lint/test scripts rõ ràng
- Backend giữ dead dependency `jsonwebtoken` dù toàn bộ flow đã dùng `@fastify/jwt`

## Research conclusions
1. **Vuetify drift**: chỉ là docs drift; runtime hiện ổn với Vuetify 4. Không nên downgrade package.
2. **Node enforcement**: cách rẻ nhất là thêm `.nvmrc` + `engines` cho 2 package; pin Docker image là bước optional.
3. **Test/lint gap**: nên làm incremental. Phase đầu chỉ cần typecheck + ESLint baseline; test runner thêm có chọn lọc.
4. **JWT overlap**: `jsonwebtoken` là dead dependency; chỉ cần uninstall, không phải migration.

## Delivery order
1. Sửa metadata/docs drift + cleanup dependency chết
2. Enforce Node version tối thiểu
3. Thêm scripts kiểm tra tối thiểu cho backend/frontend
4. Thiết lập lint baseline
5. Chỉ sau đó mới cân nhắc test runner tối thiểu

## Phase map
- [Phase 01 — Align docs and remove dead dependency](./phase-01-align-docs-and-cleanup-deps.md)
- [Phase 02 — Enforce Node version](./phase-02-enforce-node-version.md)
- [Phase 03 — Add baseline verification scripts](./phase-03-add-baseline-verification-scripts.md)
- [Phase 04 — Add ESLint baseline](./phase-04-add-eslint-baseline.md)
- [Phase 05 — Add minimal targeted tests](./phase-05-add-minimal-targeted-tests.md)

## Success criteria
- README phản ánh đúng stack thực tế
- Repo có source of truth rõ cho Node version local/container
- Cả backend/frontend có script kiểm tra tối thiểu để chạy trước commit
- Backend không còn dependency JWT thừa
- Có roadmap incremental cho test/lint, không dựng quá tay

## Out of scope
- Full CI/CD pipeline mới
- Playwright/E2E
- Husky/lint-staged
- Frontend component test diện rộng
- Refactor auth flow beyond dependency cleanup

## Relevant research reports
- `plans/reports/researcher-260419-1623-jwt-overlap.md`
- `plans/reports/researcher-260419-1623-node-version-enforcement.md`
- `plans/reports/researcher-260419-1623-test-lint-tooling-gap.md`

## Unresolved questions
- Team có CI ngoài Docker không? Nếu có, nên thêm Node setup step sau phase 02.
- Có muốn pin exact Docker image patch ngay hay giữ `node:20-alpine` để giảm churn?
- Có ưu tiên backend tests trước frontend tests không? Hiện khuyến nghị là có.
