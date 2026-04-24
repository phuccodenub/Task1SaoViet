# Phase 02 — Enforce Node version

## Context Links
- `README.md`
- `docker/Dockerfile`
- `docker-compose.yml`
- `backend/package.json`
- `frontend/package.json`
- `plans/reports/researcher-260419-1623-node-version-enforcement.md`

## Overview
- Priority: P1
- Status: pending
- Goal: tạo source of truth rõ cho Node version ở local dev và package metadata

## Key Insights
- README và Docker đang ngầm thống nhất Node 20
- Local dev chưa có guardrail
- Cách tối giản nhất: `.nvmrc` + `engines`

## Requirements
- Có cách để dev local tự nhận Node version đúng
- Package metadata thể hiện rõ range hỗ trợ
- Không ép buộc setup phức tạp

## Related Code Files
Files to modify:
- `.nvmrc`
- `backend/package.json`
- `frontend/package.json`
- optional: `docker/Dockerfile`

## Implementation Steps
1. Tạo `.nvmrc` ở root với `20`
2. Thêm `engines.node` vào backend/frontend: `>=20 <21`
3. Quyết định có pin Docker patch version ngay hay để phase sau
4. Chạy install/build command để xác nhận package metadata không gây lỗi
5. Nếu có CI ngoài Docker, ghi follow-up task cập nhật CI setup-node

## Todo List
- [ ] Thêm `.nvmrc`
- [ ] Thêm `engines` cho backend
- [ ] Thêm `engines` cho frontend
- [ ] Quyết định pin Docker patch hay không

## Success Criteria
- Repo có source of truth rõ cho Node local
- Cả hai package khai báo Node support range
- Không có mismatch với Docker/README

## Risk Assessment
- Risk thấp: npm chỉ warning nếu không bật strict engines
- Mitigation: dùng range rộng trong major 20, tránh pin quá cứng ở package level

## Security Considerations
- Giảm lỗi môi trường dẫn đến behavior bất định

## Next Steps
- Sang phase 03 thêm baseline verification scripts

## Unresolved questions
- CI hiện có chạy ngoài Docker không?
- Team dùng nvm/fnm hay tool khác?
