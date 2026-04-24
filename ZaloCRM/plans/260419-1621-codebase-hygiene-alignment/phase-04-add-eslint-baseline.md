# Phase 04 — Add ESLint baseline

## Context Links
- `backend/package.json`
- `frontend/package.json`
- source trees trong `backend/src` và `frontend/src`
- `plans/reports/researcher-260419-1623-test-lint-tooling-gap.md`

## Overview
- Priority: P2
- Status: pending
- Goal: thêm lint baseline đủ dùng, không over-config

## Key Insights
- Repo hiện không có lint tool
- Cần incremental rollout để tránh ngập cảnh báo
- Backend và frontend cần stack rule khác nhau

## Requirements
- Backend có ESLint cho TypeScript
- Frontend có ESLint cho TypeScript + Vue
- Rule set tối giản: syntax, unused vars, obvious mistakes
- Không theo đuổi style wars ở phase đầu

## Related Code Files
Files to modify/create:
- `backend/package.json`
- `frontend/package.json`
- `backend/.eslintrc.*` hoặc `eslint.config.*`
- `frontend/.eslintrc.*` hoặc `eslint.config.*`
- optional ignore files

## Implementation Steps
1. Chọn một kiểu config thống nhất: flat config ưu tiên nếu toolchain hỗ trợ ổn
2. Backend: cài `eslint`, `typescript-eslint`
3. Frontend: thêm `eslint-plugin-vue`
4. Viết rules tối giản, tập trung lỗi thật
5. Thêm script `lint`
6. Chạy lint, fix lỗi mức dễ và rule config trước; chưa mở rộng strictness quá sớm

## Todo List
- [ ] Chọn config format ESLint
- [ ] Cài deps lint cho backend
- [ ] Cài deps lint cho frontend
- [ ] Thêm script `lint`
- [ ] Chạy lint và fix baseline errors

## Success Criteria
- Cả hai app có `lint` command chạy được
- Rule set không tạo noise quá mức
- Các lỗi obvious được bắt trước commit

## Risk Assessment
- Risk trung bình: lint rollout làm lộ nhiều vấn đề cũ
- Mitigation: bắt đầu với baseline rules, không bật full strict preset

## Security Considerations
- Lint hỗ trợ bắt pattern lỗi phổ biến nhưng không thay security review

## Next Steps
- Sang phase 05 để thêm test tối thiểu có ROI cao

## Unresolved questions
- Có muốn dùng chung root ESLint config không, hay giữ tách backend/frontend cho đơn giản?
