# Research: Node Version Enforcement — ZaloCRM

Date: 2026-04-19

## Current State

| Source | Node version implied |
|--------|---------------------|
| README.md | "Node.js 20" (tường minh) |
| `docker/Dockerfile` | `node:20-alpine` (cả 3 stages) |
| `backend/package.json` | ❌ không có `engines` field |
| `frontend/package.json` | ❌ không có `engines` field |
| `.nvmrc` | ❌ không tồn tại |
| `docker-compose.dev.yml` | Backend chạy local (`npm run dev`) — không enforce gì |

**Mismatch hiện tại:** Không có mismatch giữa các nguồn (đều Node 20), nhưng local dev hoàn toàn không có guardrail — dev chạy bất kỳ Node version nào.

**Rủi ro:** `@types/node@^25.5.0` (backend) và `@types/node@^24.12.0` (frontend) imply Node ≥ 20 API surface. Nếu ai dùng Node 18 local, có thể gặp type error hoặc runtime issue. `typescript@^6.0.2` cũng mới, chưa rộng rãi.

---

## So sánh các lựa chọn

| Option | Effort | Scope | Enforcement strength | Notes |
|--------|--------|-------|---------------------|-------|
| `.nvmrc` (value: `20`) | Cực thấp — 1 file 1 dòng | Local dev (nvm/fnm) | Soft — chỉ auto-switch nếu dev dùng nvm/fnm | Chuẩn ngành, không break gì |
| `engines` in package.json | Thấp — 4 dòng × 2 file | npm install / CI | Medium — npm warn, yarn/pnpm error nếu `--engine-strict` | Hiển thị rõ yêu cầu |
| Docker base image pinning (`node:20.19-alpine`) | Thấp | Container | High — cố định patch version | Tránh breaking change khi alpine rebuild |
| `volta` field in package.json | Thấp | Local dev (Volta users) | Hard — Volta auto-switch | Ít phổ biến hơn nvm |
| `compose` comment/note | Cực thấp | Documentation only | Zero enforcement | Đã có README |

---

## Recommendation — thứ tự triển khai

**Tối giản, hiệu quả nhất:**

### Bước 1 — `.nvmrc` (1 file)
```
20
```
→ Đặt ở root. Ai dùng nvm/fnm sẽ auto-switch. Standard signal cho team + CI.

### Bước 2 — `engines` cả 2 package.json
```json
"engines": {
  "node": ">=20.0.0 <21"
}
```
→ `backend/package.json` + `frontend/package.json`. Cho npm hiện warning nếu sai version, CI với `--engine-strict` sẽ fail hard.

### Bước 3 — Pin Docker base image (optional nhưng khuyến nghị)
Đổi `node:20-alpine` → `node:20.19-alpine3.21` (hoặc latest LTS patch).
→ Tránh surprise khi `node:20-alpine` track latest 20.x release.

**KHÔNG cần làm:** docker-compose note, Volta field, thay đổi CI config (nếu CI build qua Docker thì đã enforce qua Dockerfile).

---

## Decision

> Chỉ cần **2 thay đổi**: thêm `.nvmrc` + thêm `engines` vào 2 `package.json`. Docker đã đúng. Tổng ~8 dòng thay đổi, không break gì.

---

## Unresolved Questions

- CI/CD hiện tại là gì? (GitHub Actions, GitLab CI,...) — nếu CI chạy `npm ci` ngoài Docker cần thêm `--engine-strict` flag hoặc setup Node version action.
- Team dùng nvm hay fnm hay Volta? → ảnh hưởng đến `.nvmrc` vs `volta` field priority.
