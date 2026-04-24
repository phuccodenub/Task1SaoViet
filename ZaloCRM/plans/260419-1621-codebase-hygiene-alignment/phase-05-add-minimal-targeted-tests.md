# Phase 05 — Add minimal targeted tests

## Context Links
- `backend/src`
- `frontend/src`
- `plans/reports/researcher-260419-1623-test-lint-tooling-gap.md`

## Overview
- Priority: P2
- Status: pending
- Goal: thêm test tối thiểu, nhắm vào logic thuần có ROI cao; tránh dựng test suite nặng ngay

## Key Insights
- Phase 1 nên ưu tiên backend logic thuần trước UI/component tests
- Không nên nhảy thẳng vào Playwright/E2E khi baseline tooling còn thiếu

## Requirements
- Chỉ test logic có giá trị rõ
- Ưu tiên backend utilities/services thuần, helper auth/parser/format/scheduler nếu có
- Frontend tests chỉ thêm khi có pure composables hoặc utils phù hợp

## Related Code Files
Files to inspect later:
- backend utility/service files có pure logic
- frontend composables/utils có pure logic
- package.json của hai app

## Implementation Steps
1. Khảo sát các file pure logic có ít dependency ngoài
2. Chọn test runner tối giản: ưu tiên Vitest cho ecosystem TS/Vite
3. Backend: thêm 3-5 test có giá trị cao cho logic thuần
4. Frontend: chỉ thêm test nếu có composable/util thật sự đáng test
5. Thêm script `test` và `test:run`
6. Không mock quá đà; chưa đụng integration/E2E ở phase này

## Todo List
- [ ] Xác định target test files ROI cao
- [ ] Cài test runner tối thiểu
- [ ] Viết test backend trước
- [ ] Đánh giá có cần frontend unit tests ngay không
- [ ] Chạy test ổn định trong local env

## Success Criteria
- Repo có test baseline thực sự hữu ích, không phải test cho có
- Test chạy nhanh, dễ bảo trì
- Không thêm hạ tầng nặng vượt nhu cầu hiện tại

## Risk Assessment
- Risk trung bình: chọn sai target test làm ROI thấp
- Mitigation: chỉ test pure logic, tránh UI/render/integration ở giai đoạn đầu

## Security Considerations
- Test giúp giữ ổn định behavior quan trọng sau cleanup/tooling rollout

## Next Steps
- Sau phase này mới cân nhắc CI gate, frontend test mở rộng, hoặc E2E

## Unresolved questions
- Backend hiện có đủ pure logic để justify Vitest ngay không?
- Có cần ưu tiên auth utils hay message parsing logic trước?
