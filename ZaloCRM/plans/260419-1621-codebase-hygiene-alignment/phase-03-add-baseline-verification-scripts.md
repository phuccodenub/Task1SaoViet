# Phase 03 — Add baseline verification scripts

## Context Links
- `backend/package.json`
- `frontend/package.json`
- `backend/tsconfig.json`
- `frontend/tsconfig.json`
- `frontend/tsconfig.app.json`
- `plans/reports/researcher-260419-1623-test-lint-tooling-gap.md`

## Overview
- Priority: P1
- Status: pending
- Goal: tạo baseline scripts để ai cũng biết phải chạy gì trước commit/push

## Key Insights
- Hiện typecheck chỉ implicit qua build commands
- Không có naming chuẩn cho verify commands
- Cần bước rẻ trước khi thêm lint/test tools

## Requirements
- Mỗi app có script `typecheck`
- Mỗi app có script `verify` hoặc tương đương để gom baseline checks
- Không thêm dependency mới ở phase này nếu không cần

## Related Code Files
Files to modify:
- `backend/package.json`
- `frontend/package.json`

## Implementation Steps
1. Backend: thêm `typecheck` dùng `tsc --noEmit`
2. Frontend: thêm `typecheck` dùng `vue-tsc --noEmit`
3. Thêm script tổng hợp rõ nghĩa, ví dụ `verify` hoặc `check`
4. Đảm bảo script names nhất quán giữa hai app
5. Cập nhật README ngắn gọn nếu cần phần local verification

## Todo List
- [ ] Thêm backend `typecheck`
- [ ] Thêm frontend `typecheck`
- [ ] Thêm script tổng hợp `verify`/`check`
- [ ] Chạy từng script để xác nhận

## Success Criteria
- Dev có command tối thiểu để tự kiểm tra trước commit
- Không cần build full mới thấy lỗi type
- Script naming nhất quán giữa backend/frontend

## Risk Assessment
- Risk thấp: có thể lộ type errors đang bị build che mất
- Mitigation: fix từng lỗi thật, không tắt rule

## Security Considerations
- Type safety tốt hơn giúp giảm bug runtime ở boundary

## Next Steps
- Sang phase 04 thêm ESLint baseline

## Unresolved questions
- Nên dùng tên script `verify`, `check`, hay `validate` để khớp thói quen team?
