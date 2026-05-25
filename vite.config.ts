/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

// Vite 8 이 module script/link 에 붙이는 crossorigin 속성을 제거한다. file://
// (Electron 프로덕션 로드)에서 crossorigin 모듈은 CORS 정책으로 차단될 수 있어
// 같은 origin asset 엔 불필요 — 제거가 가장 단순한 회피.
function stripCrossoriginPlugin(): Plugin {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      // crossorigin / crossorigin="..." / crossorigin='...' 세 변형 모두.
      return html.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'))?(?=[\s>])/g, '')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stripCrossoriginPlugin()],
  // Electron 으로 마이그레이션: 프론트엔드는 그대로 두고 Tauri API import 만
  // Electron IPC 기반 shim 으로 치환한다 (preload 가 노출한 window.__TP__ 사용).
  resolve: {
    alias: [
      { find: '@tauri-apps/api/core', replacement: resolve(__dirname, 'src/tauri-shim/core.ts') },
      { find: '@tauri-apps/api/event', replacement: resolve(__dirname, 'src/tauri-shim/event.ts') },
      { find: '@tauri-apps/api/window', replacement: resolve(__dirname, 'src/tauri-shim/window.ts') },
      { find: '@tauri-apps/plugin-store', replacement: resolve(__dirname, 'src/tauri-shim/plugin-store.ts') },
      { find: '@tauri-apps/plugin-notification', replacement: resolve(__dirname, 'src/tauri-shim/plugin-notification.ts') },
    ],
  },
  // vitest 탐색 범위: 우리 소스/일렉트론 테스트만. node_modules 는 .nosync 로
  // 이름이 바뀌어 있어(iCloud 동기화 제외) 기본 제외 패턴(**/node_modules/**)에
  // 안 걸리므로, include 로 우리 테스트만 명시해서 의존성 내부 테스트 스캔을 막는다.
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.mjs'],
  },
  // file:// 로드(프로덕션) 시 절대경로(/assets/..)는 안 풀리므로 상대경로로.
  base: './',
  // 멀티페이지: 각 창이 자기 전용 HTML 진입점을 로드한다. 런타임 라벨 추측
  // 없이 진입점 자체가 어떤 컴포넌트를 그릴지 결정 (App.tsx 상단 주석 참고).
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        onboarding: resolve(__dirname, 'onboarding.html'),
        changelog: resolve(__dirname, 'changelog.html'),
        preview: resolve(__dirname, 'preview.html'),
        'skin-grid': resolve(__dirname, 'skin-grid.html'),
      },
    },
  },
})
