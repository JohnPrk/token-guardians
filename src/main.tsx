import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './index.css'
import App from './App.tsx'

// index.html의 inline script와 같은 효과를 React 진입에서도 한 번 더 강제.
// 펫 윈도우(라벨 "main")일 때만 root chain의 pointer-events를 none으로 박아
// 빈 영역 클릭이 데스크톱으로 통과되게 한다. CSS :has() 의존 없이 가장
// 신뢰 가능한 경로.
//
// v1.74.3: URL 의존(query/hash 둘 다)을 Windows WebView2 가 떨궈서
// Tauri 윈도우 라벨로 전환. App.tsx 의 viewFromTauri 와 동일 사유.
// 라벨 == "main" 이거나 라벨을 못 읽으면(브라우저 dev 직접 접근 등)
// 안전하게 PetApp 으로 떨어지는 폴백.
{
  let isPetWindow = false
  // v1.74.6: Rust 측 initialization_script sentinel 최우선. Windows WebView2
  // 에서 `getCurrentWindow().label` 이 `__TAURI_INTERNALS__` 주입 레이스로
  // 빈 값을 반환하던 회귀 우회. App.tsx 의 viewFromTauri 와 동일 사유.
  const injected = (window as unknown as { __TAURI_VIEW_LABEL__?: string })
    .__TAURI_VIEW_LABEL__
  if (injected) {
    isPetWindow = injected === 'main'
  } else {
    try {
      const label = getCurrentWindow().label
      isPetWindow = label === 'main'
    } catch {
      // 브라우저 dev 컨텍스트 — URL 폴백 (옛 hash/query 둘 다 검사).
      const raw = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash
      const hashView = new URLSearchParams(raw).get('view')
      const queryView = new URLSearchParams(window.location.search).get('view')
      isPetWindow = !hashView && !queryView
    }
  }
  if (isPetWindow) {
    document.documentElement.style.pointerEvents = 'none'
    document.body.style.pointerEvents = 'none'
    const root = document.getElementById('root')
    if (root) root.style.pointerEvents = 'none'
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
