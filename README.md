# 토큰 지키미 (Token Guardians)

> 데스크톱 한구석에서 너의 Claude 토큰 잔량을 지켜봐주는 작은 지키미.

[![Download .dmg](https://img.shields.io/badge/Download-.dmg%20v2.34.0-6b4cff?style=for-the-badge&logo=apple)](https://github.com/JohnPrk/token-guardians/releases/latest/download/token-panda_2.34.0_arm64.dmg)
[![Download Windows](https://img.shields.io/badge/Download-Windows%20v2.34.0-0078d4?style=for-the-badge&logo=windows)](https://github.com/JohnPrk/token-guardians/releases/latest/download/token-panda_2.34.0_x64-setup.exe)
[![소개 페이지](https://img.shields.io/badge/%EC%86%8C%EA%B0%9C%20%ED%8E%98%EC%9D%B4%EC%A7%80-%EB%B0%94%EB%A1%9C%EA%B0%80%EA%B8%B0-ff8a3d?style=for-the-badge&logo=github&logoColor=white)](https://johnprk.github.io/token-guardians/)
[![platform](https://img.shields.io/badge/platform-macOS%2011%2B%20%C2%B7%20Windows%2010%2B-lightgrey?style=for-the-badge)](#다운로드)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](#라이선스)

<p align="center">
  <img width="400" height="401" alt="토큰 지키미" src="https://github.com/user-attachments/assets/42ef49ac-fa56-4017-bb0e-937d0f1a0faa" />
</p>

claude.ai 토큰 잔량을 메뉴바와 데스크톱 캐릭터로 라이브 표시해주는 macOS · Windows 앱입니다. 질문을 던지면 5분 프롬프트 캐시 타이머가 돌고, 만료 전에 지키미가 흔들리며 신호를 보내 캐시 골든타임을 놓치지 않게 도와줍니다.

> [!TIP]
> 마지막 요청에서 5분 안에 다음 요청을 보내면 직전까지의 컨텍스트가 캐시 히트로 처리돼 토큰 사용량이 `1/10` 로 줄어듭니다.

**기능 소개 · 캐릭터 · 셋업 가이드는 소개 페이지에 전부 정리돼 있습니다 → [johnprk.github.io/token-guardians](https://johnprk.github.io/token-guardians/)**

## 다운로드

| OS | 받는 곳 | 첫 실행 |
| --- | --- | --- |
| **macOS 11+** (Apple Silicon) | 상단 `Download .dmg` 배지 | 서명·공증 완료 — 그냥 더블클릭으로 열립니다 |
| **Windows 10+** (x64) | 상단 `Download Windows` 배지 | 미서명 — SmartScreen 경고 시 `자세히 → 실행` 한 번 |

`.dmg` 를 열어 `Applications` 폴더로 드래그하면 끝입니다. macOS 빌드는 Apple Developer ID 서명 + 공증(notarization)을 거쳐 Gatekeeper 경고 없이 바로 실행됩니다. Windows 설치는 현재 사용자 범위(`%LOCALAPPDATA%`)로 들어가 관리자 권한이 필요 없습니다.

전체 릴리스 내역은 [GitHub Releases](https://github.com/JohnPrk/token-guardians/releases) 에서 받을 수 있습니다.

## 직접 빌드

```bash
git clone https://github.com/JohnPrk/token-guardians.git
cd token-guardians
npm install

npm run dist:mac      # → release/token-panda_<version>_arm64.dmg
npm run dist:win      # → release/token-panda_<version>_x64-setup.exe
npm run electron:dev  # 개발 모드 (vite + electron 동시 기동, HMR)
```

Node 18+ / Electron 33 + electron-builder 26 (Rust toolchain 불필요).

## 프라이버시

Org ID 와 세션 쿠키는 이 컴퓨터 안에만 저장되고, 잔량 조회를 위해 `claude.ai` 로만 전송됩니다. "연동 해제" 시 즉시 삭제됩니다. 이 자격증명은 사실상 본인 Claude 세션 권한이라, 가져간 사람이 본인 계정의 사용량을 조회·소모할 수 있으니 외부에 노출되지 않게 주의하세요. 쿠키가 의심스러우면 [claude.ai/settings/account](https://claude.ai/settings/account) → "활성 세션"에서 로그아웃하면 곧바로 무효화됩니다.

## 라이선스

MIT — 자유롭게 포크/수정/재배포하세요. 자세한 내용은 [`LICENSE`](LICENSE) 참고.

## 연락

버그를 발견했거나 기능 추가가 필요하면 편하게 연락주세요. 프로젝트가 도움이 되셨다면 우측 상단의 ⭐️ **Star** 를 눌러주시면 큰 힘이 됩니다!

- 📧 [johnprk1993@gmail.com](mailto:johnprk1993@gmail.com)
- 🐛 [Issues](https://github.com/JohnPrk/token-guardians/issues)
- 💬 [Discussions](https://github.com/JohnPrk/token-guardians/discussions)

## 감사의 말

[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 프로젝트에서 영감을 받아 제작되었습니다.
