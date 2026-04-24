# Research: Test/Lint Tooling Gap — ZaloCRM

Date: 2026-04-19

---

## Hiện trạng

### Backend (`backend/`)
- Stack: Fastify + Prisma + TypeScript (strict), ESM, Node
- Scripts: `dev`, `build` (tsc), `start`, `db:*` — **không có** `test`, `lint`, `typecheck`
- `tsconfig.json`: `strict: true`, `module: NodeNext` — solid, build = implicit typecheck
- Không có: ESLint, Prettier, Vitest, Jest, any test runner

### Frontend (`frontend/`)
- Stack: Vue 3 + Vite + Vuetify + Pinia, TypeScript
- Scripts: `dev`, `build` (`vue-tsc -b && vite build`), `preview` — **không có** `test`, `lint`
- `build` script = implicit typecheck qua `vue-tsc`
- Không có: ESLint, Prettier, Vitest, any test runner

### Kết luận gap
| Capability | Backend | Frontend |
|---|---|---|
| Typecheck | ✅ `tsc` (via build) | ✅ `vue-tsc` (via build) |
| Lint | ❌ | ❌ |
| Format | ❌ | ❌ |
| Unit test | ❌ | ❌ |
| E2E test | ❌ | ❌ |
| Dedicated typecheck script | ❌ | ❌ |

---

## Đề xuất baseline tối thiểu (YAGNI/KISS)

### Phase 1 — Bắt buộc, nên làm ngay

**1. Typecheck script riêng (không cần install gì)**
- Backend: thêm `"typecheck": "tsc --noEmit"` vào scripts
- Frontend: thêm `"typecheck": "vue-tsc --noEmit -p tsconfig.app.json"` vào scripts
- Chi phí: ~2 dòng config. Cho phép CI/CD check type mà không cần build output.

**2. ESLint (cả 2 app)**
- Backend: `eslint` + `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser`
  - Config tối giản: recommended rules, no opinionated formatting
- Frontend: thêm `eslint-plugin-vue` + `vue-eslint-parser`
  - Dùng `eslint-config-vue` hoặc flat config `@vue/eslint-config-typescript`
- Thêm script: `"lint": "eslint src --ext .ts,.vue --max-warnings 0"`
- Không cần Prettier riêng — ESLint đủ để catch real errors

**3. Vitest cho backend (unit test cơ bản)**
- Backend có logic business (auth, Zalo webhook, scheduler) → unit test có giá trị ngay
- Install: `vitest` + `@vitest/coverage-v8`
- Script: `"test": "vitest run"`, `"test:watch": "vitest"`
- Chỉ test pure functions, utils, service logic — **không test DB/Prisma/external** ở phase này
- Target: 5-10 test files cho core logic, không ép coverage %

### Phase 2 — Nên để sau

**4. Frontend unit test (Vitest + Vue Test Utils)**
- Vue components test ít ROI hơn backend logic test với codebase này
- Có thể thêm khi feature ổn định hơn
- Install khi cần: `vitest`, `@vue/test-utils`, `@vitejs/plugin-vue`

**5. Prettier / format**
- Không cần ngay — chỉ thêm nếu team mở rộng và có conflict style
- Nếu thêm: dùng `prettier` + `eslint-config-prettier` để tắt formatting rules trong ESLint

**6. E2E test (Playwright/Cypress)**
- Nặng, setup phức tạp, chỉ có giá trị khi app đủ stable
- Để sau milestone đầu tiên

**7. Husky / lint-staged (pre-commit hooks)**
- Hữu ích nhưng không critical; thêm sau khi lint script đã ổn định

---

## Incremental adoption path

```
Tuần 1: thêm typecheck scripts (0 install)
Tuần 2: ESLint backend → fix warnings → commit
Tuần 3: ESLint frontend → fix warnings → commit  
Tuần 4: Vitest backend, viết 5-10 tests cho auth/utils
Sau đó: frontend test, prettier, hooks — theo nhu cầu thực tế
```

---

## Unresolved questions
- Backend có `src/modules/` và `src/shared/` — chưa biết có logic thuần (pure functions) không, ảnh hưởng ROI vitest
- CI/CD pipeline hiện tại (GitHub Actions?) dùng cấu hình nào? Nếu chưa có, phase 1 sẽ đơn giản hơn
- Team size? Nếu solo dev, Prettier + Husky có thể skip hoàn toàn
