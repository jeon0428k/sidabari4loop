import { defineConfig } from "vitest/config";

// 단위 테스트 전용 설정. vite.config.ts(react/tailwind 플러그인)를 끌어오지 않도록 분리한다.
// 순수 로직(evaluateLoopSignal 등) 테스트라 node 환경이면 충분하다.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
