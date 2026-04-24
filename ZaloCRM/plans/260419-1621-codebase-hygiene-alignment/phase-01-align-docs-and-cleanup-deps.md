# Phase 01 — Align docs and remove dead dependency

## Context Links
- `README.md`
- `frontend/package.json`
- `frontend/package-lock.json`
- `backend/package.json`
- `plans/reports/researcher-260419-1623-vuetify-drift.md` *(nếu không có file này, dùng kết quả research inline trong phiên)*
- `plans/reports/researcher-260419-1623-jwt-overlap.md`

## Overview
- Priority: P1
- Status: pending
- Goal: sửa drift tài liệu và loại bỏ dependency JWT chết với rủi ro gần như bằng 0

## Key Insights
- Repo thực tế dùng `vuetify@4.0.4`
- README ghi `Vuetify 3` là sai docs, không phải bug runtime
- Backend không dùng `jsonwebtoken` trong `src/`; toàn bộ flow dùng `@fastify/jwt`

## Requirements
- Đồng bộ README với stack thực tế
- Không thay behavior runtime
- Không hạ version Vuetify
- Gỡ `jsonwebtoken` và `@types/jsonwebtoken`

## Related Code Files
Files to modify:
- `README.md`
- `backend/package.json`
- lockfile tương ứng của backend nếu npm cập nhật

## Implementation Steps
1. Sửa `README.md` phần stack frontend: `Vuetify 3` → `Vuetify 4`
2. Quét nhanh docs khác nếu tồn tại tham chiếu version Vuetify
3. Remove `jsonwebtoken` + `@types/jsonwebtoken` khỏi backend
4. Chạy install/update lockfile đúng package manager đang dùng
5. Chạy grep xác nhận không còn import nhầm dependency cũ

## Todo List
- [ ] Sửa README stack version
- [ ] Gỡ 2 package JWT thừa
- [ ] Cập nhật lockfile backend
- [ ] Xác nhận backend vẫn build/typecheck

## Success Criteria
- README phản ánh đúng Vuetify 4
- `backend/package.json` không còn `jsonwebtoken`
- Build/typecheck backend không lỗi sau cleanup

## Risk Assessment
- Risk thấp: lockfile thay đổi ngoài mong muốn
- Mitigation: chỉ uninstall package đã xác minh dead dependency

## Security Considerations
- Giảm bề mặt dependency thừa
- Không thay auth logic runtime

## Next Steps
- Sang phase 02 để enforce Node version

## Unresolved questions
- Có docs nào ngoài README đang ghi Vuetify 3 không?
