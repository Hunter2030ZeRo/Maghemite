# 모듈 런타임 최적화와 제품 공백 점검 — 2026-09-27

## 구현한 변경

1. **WASM 검증 메모리 고정:** `src/modules/host/manifest.ts`의 SHA-256 검증을 256 KiB 스트리밍으로 변경했다. 설치·등록·실행 시 검증을 생략하거나 결과를 무조건 재사용하지 않는다. 파일 크기 제한, 실제 경로 검사, 잘림/늘어남 검사, 전체 해시, Core WASM 헤더 검사도 유지한다. Deno가 제공하는 `node:crypto` 호환 API이며 별도 Node 실행 파일이 필요하지 않다.
2. **바이트 전송:** `src/modules/host/wasm_tools.ts`와 `modules/language-common/transport.ts`의 자바스크립트 spread/문자열/콜백 변환을 런타임의 `Uint8Array.toBase64/fromBase64`로 바꿨다. WASI 스트림을 사용하는 모든 종류의 모듈에 적용된다. 24 KiB 청크, 권한, 소유권, 역압력과 취소 경로를 유지했다.
3. **컴파일 작업자 수명 공통화:** Component Model과 preview1 WASI 명령이 `native/crates/wasm-host/src/startup.rs`의 같은 컴파일 풀을 사용한다. OS 스레드를 join하여 TLS 정리가 끝난 후 유휴 allocator 메모리를 반환한다. 성공뿐 아니라 컴파일 오류 경로도 정리한다. 스레드 수/연료/메모리/시간 제한은 유지한다. preview1의 기존 단순 pool drop 경로를 교체했다.
4. **재현 도구:** `modules-sdk/tooling/runtime_performance.ts`, `deno task modules:runtime-perf --output=/absolute/report.json`을 추가했다. 실제 TypeScript/OXC/LLVM 도구와 격리된 임시 캐시를 사용한다. 사용자 설치 목록과 권한을 변경하지 않는다.

SDK가 언어 전용으로 바뀐 것은 아니다. 컴파일 관리와 WASI 바이트 스트림은 변환기, 데이터 처리기, 분석기 등에도 적용되는 호스트 기능이다. 공통 언어 어댑터를 포함하는 JS/TS 및 C/C++ 패키지는 `0.1.0-alpha.2`로 갱신했다. 분석 엔진 WASM 바이너리와 체크섬은 동일하다.

## 측정 결과

Linux x86_64, Deno 2.9.7, Wasmtime 49.0.1, 논리 CPU 22개. 검증은 새 Deno 프로세스 3개씩, 언어 시나리오는 새 호스트 3개씩(Wasmtime 캐시 cold 1회 + warm 2회). 각 시나리오는 선언 400개 문서에서 첫 호버, 서로 다른 위치 20회, 같은 위치 20회, 수정 5회, 토큰 첫 페이지, 포매팅을 실행했다. 데이터는 강제 GC 없이 기록했다. OS 파일 캐시는 비우지 않았다. 코드는 저장하지 않았다.

| 측정 항목 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| JS/TS 패키지 검증 시간 | 86.2 ms | 74.2 ms |
| JS/TS 검증 프로세스 최대 RSS | 134.7 MiB | 48.3 MiB |
| JS/TS 반복 호버 p50 (서로 다른 위치) | 2.72 ms | 2.13 ms |
| JS/TS 수정 후 호버 p50 | 15.59 ms | 12.84 ms |
| C/C++ 패키지 검증 시간 | 107.0 ms | 90.5 ms |
| C/C++ 검증 프로세스 최대 RSS | 190.8 MiB | 48.7 MiB |
| C/C++ 반복 호버 p50 (서로 다른 위치) | 2.19 ms | 2.00 ms |
| C/C++ 수정 후 호버 p50 | 30.14 ms | 28.60 ms |

검증 단계 최대 RSS는 JS/TS 약 64%, C/C++ 약 74% 감소했다. 이는 파일 검증을 수행하는 **호스트 프로세스의 해당 시나리오** 수치다. 앱 전체 또는 분석 엔진 전체 메모리가 이 비율로 줄었다는 의미가 아니다. 두 번의 warm 시나리오에서 얻은 호버 수치는 짧은 표본이며 성능 보장이나 타 에디터와의 비교가 아니다.

별도 24 KiB Base64 마이크로벤치마크에서도 기본 제공 코덱의 비용이 크게 낮았다. 각 변환의 원시 표본을 JSON에 남겼다. 이 배수를 앱 전체 속도 향상으로 환산하지 않았다.

### 남아 있는 비용과 좋지 않은 수치도 포함

- JS/TS 첫 호버: cold 약 11.37 → 11.32초, warm 약 678 → 659 ms.
- C/C++ 첫 호버: cold 약 22.49 → 23.14초, warm 약 2678 → 2703 ms. **최초 JIT/언어 서버 초기화 속도는 개선하지 못했다.**
- 전체 모듈 프로세스들의 작업 후 합산 RSS(warm 중앙값): JS/TS 약 303 → 300 MiB, C/C++ 약 347 → 349 MiB. **상주 메모리의 큰 개선은 아직 없다.**
- C++ cold 시나리오에서 50 ms 간격으로 샘플링한 트리 최대 RSS는 약 1.61 GiB로 여전히 높다. 이 최대값에는 JIT 네이티브 할당이 포함되므로 512 MiB guest linear-memory 제한과 다르다.
- 샘플된 warm C++ 트리 최대값은 약 383 → 484 MiB로 오히려 높게 잡혔다. 하위 Wasmtime 프로세스 자체의 VmHWM은 전후 약 387 MiB로 비슷하고, Deno 호스트 VmHWM은 약 195 → 64 MiB다. 50 ms 트리 샘플은 짧은 피크를 놓치며 각 프로세스를 동시에 읽지도 않으므로, **트리 최대 메모리 개선은 입증되지 않았다.**
- RSS 합계는 공유 페이지를 중복 계산한다. CEF/렌더러/GPU/PTY/네이티브 인덱서를 포함한 전체 앱의 PSS·CPU·입력 지연은 이번 측정 범위 밖이다. 종료 후 OS가 캐시를 보유하는 것도 앱 누수와 구별해야 한다.

[변경 전 원시 데이터](runtime-performance-before-2026-09-27.json) · [변경 후 원시 데이터](runtime-performance-after-2026-09-27.json)

## 실제 코드에서 확인한 공백과 다음 순서

### 1. 프로젝트 단위 언어 서비스와 편집 기능 (우선)

- `modules-sdk/js/language.ts`: protocol 1은 `scope: document`, completion/hover/definition/diagnostics/semanticTokens/formatting 6개 기능이다.
- `src/desktop/languages.ts`: 문서 128 KiB 제한, 전체 스냅샷 청크 동기화, 단일 provider 큐. 파일 간 이동·참조, rename, code action, signature help, inlay hints, completion resolve/auto-import의 공통 계약이 부족하다.
- Rust에는 Cargo/workspace 소스와 stdlib 분석이 일부 존재한다. 이를 없는 것으로 취급하면 안 된다. 다만 공통 반환 프로토콜은 파일 간 탐색을 제공하지 않고 registry/git 의존성, proc macro/build script, 타깃 해석도 불완전하다.
- Python/JS/TS/C++는 단일 문서 분석 중심이다. 프로젝트 의존성과 설정, Python 환경, JS tsconfig/모듈 해석, C++ compile_commands를 권한과 가상 파일시스템 경계 안에서 연결해야 한다.
- 변경 대상: `modules-sdk/js/language.ts`, 각 언어 바인딩/모듈, `src/desktop/languages.ts`, `renderer/src/editors/language.ts`, `renderer/src/editors/monaco.ts`. 버전·취소·다중 문서 편집/undo를 공통화하고 이전 provider와 호환되는 protocol 2를 권장한다.

### 2. 전역 자원 관리와 첫 실행 비용 (우선)

- `src/modules/host/host.ts`, `wasm_tools.ts`, `native/crates/wasm-host/src/startup.rs`: 개별 제한과 지연 실행, idle 정리는 있으나 **프로세스들을 합친 JIT 동시 실행/메모리 예산이 없다.**
- 다음 순서: 모듈별 활성/컴파일/유휴 상태와 시간·메모리 수집 → 호스트 공통 컴파일 입장 제어 → 메모리 압력에 따른 유휴 서비스 해제 → 캐시/설치 파일 중복 제거. 선행 측정 없이 무조건 thread를 늘리거나 모든 서비스를 미리 띄우지 않는다.
- 모듈 진단 화면과 장애 원인(시간 초과/메모리/권한/guest crash) 표시도 보강할 필요가 있다. 전체 앱 PSS/CPU/입력 지연을 함께 측정하는 회귀 기준은 `RESOURCE_POLICY.md`에 계획만 있고 CI gate가 없다.

### 3. 디스크 전체 검색과 일상적인 파일 조작 (우선)

- `renderer/src/workbench/Sidebar.tsx`와 `renderer/src/workspace/application.ts`의 검색은 `state.documents`/로드된 문서 배열을 순회한다. **열지 않은 디스크 파일 내용은 검색하지 않는다.** 인덱스 질의 API가 있다는 사실과 전체 파일 내용 검색은 별개다.
- Rust 코어에 취소 가능한 스트리밍 내용 검색을 추가하고, SDK와 UI가 같은 서비스를 사용하게 해야 한다. 정규식/대소문자/제외 경로와 검색 결과 페이지, 변경 전 검토가 가능한 전체 바꾸기가 필요하다.
- `renderer/src/workbench/DiskExplorer.tsx`는 현재 열기·생성·새로고침 중심이다. rename/move/delete/휴지통 UI, 파일 변경 알림과 트리 갱신을 완성하고 문서 ID·dirty buffer·노트 링크의 경로 변경 처리를 함께 설계해야 한다.

### 4. 문서/탭 모델의 편집기 그룹

- `src/shared/workspace.ts`의 Session은 `tabs` 하나와 `activeTab` 하나다. 패널 크기 조절은 있지만 VS Code/Zed식 다중 편집기 그룹 모델은 없다.
- `renderer/src/workspace/store.ts`, `EditorTabs.tsx`, `App.tsx`에 그룹별 활성 탭, 분할/이동, 공유 문서와 독립 view state, 복구 직렬화를 추가한다. 지금 승인된 큰 레이아웃은 유지할 수 있다.

### 5. 지식 작업의 Markdown 완성도

- `renderer/src/workbench/Markdown.tsx`는 작은 정규식 기반 preview다. 일반 Markdown 링크/이미지, 표/체크리스트, 중첩 목록, 강조 문법 전반, frontmatter 속성, 수식·첨부파일 흐름이 완성되지 않았다. CodeMirror 편집 엔진이 있다는 것과 읽기/지식 모델 완성도는 별개다.
- CommonMark/GFM 파싱과 안전한 렌더링을 공통화하고, 인덱스/미리보기/아웃라인의 문법 해석을 맞춰야 한다. 위키 링크의 heading/block 이동 및 파일 rename 시 링크 갱신도 다음 단계다.
- 그래프/백링크는 이미 네이티브 인덱스와 unsaved overlay를 사용한다. 다만 200개 노트 표시와 10,000개 인덱스 항목 상한, 코드 아웃라인 20개/저장본 제약이 있으므로 대규모 데이터는 가상화와 점진적 조회가 필요하다.

### 6. 일반 모듈 생태계와 SDK의 표현력

- `src/desktop/module_manager.ts`, `ModuleManager.tsx`: 로컬 패키지 설치·수동 업데이트·삭제·권한 opt-in/out은 구현돼 있다. 마켓플레이스, 서명된 배포 메타데이터, 원격 업데이트/호환성 협상, 의존성 공유는 미완성이다.
- `src/modules/host/manifest.ts`, `modules-sdk/js/app.ts`, `ModuleViews.tsx`: 현재 선언형 뷰는 텍스트·코드·버튼 중심이다. 모듈의 메뉴/단축키/설정 스키마, 트리/표/폼·상태 표시 contribution을 확대하면 Git, 도구 통합, 지식 작업 모듈에도 도움이 된다.
- 언어 모듈을 SDK 자체와 동일시하지 않는다. 언어 API는 문서·파일·명령·설정·이벤트·작업·뷰·컴퓨팅 API 위의 한 영역으로 유지한다.

### 7. 언어별 배포 완성도

- 현재 모듈 디렉토리는 Rust, Python, JS/TS, C/C++다. 논의했던 **Go/gopls 모듈은 아직 없다.**
- Rust의 rustfmt/Clippy/디버거, Python의 프로젝트 환경/디버거, JS/TS와 C/C++의 디버거·프로젝트 설정·빌드 연계 등이 패키지 계약을 채우지 못했다. 엔진을 실제 포함한 preview이지만 완전한 개발 툴체인은 아니다.
- Git과 디버깅은 사용자가 정한 대로 모듈 책임으로 둔다. 코어 누락 기능으로 강제 편입하지 않고, 공통 서비스·UI·권한 계약과 실제 모듈을 함께 완성해야 한다.

## 이미 있어서 재구현할 필요가 없는 기반

폴더 열기/최근 폴더, 사용자·워크스페이스 설정, 테마와 폰트 선택, 파일 저장의 버전 검사, 복구 스냅샷, xterm/deno-pty/WebGL 터미널, Tree-sitter 인덱스, 그래프/백링크, 권한 UI와 로컬 모듈 관리, Monaco/CM6 연결은 구현되어 있다. 복구는 전체 snapshot 방식이며 per-keystroke journal/백업은 아니다. Linux 패키징은 여러 형식이 있지만 macOS/Windows 실행 및 접근성·IME·장시간 사용 검증은 별도 범위다.

이번 작업에서는 공백을 기록했고, 승인된 레이아웃 변경이나 미완성 기능 전체의 일괄 구현은 하지 않았다.

## 검증 및 산출물

- 실제 JS/TS·C++·Python·Rust, 설치/삭제, 권한·취소·idle·캐시·Unicode/바이너리 전송 검증 27개 및 일반 모듈 테스트 묶음 50개 통과. 중복 15개를 제외하면 Deno 테스트 62개이며, 별도로 작업 서비스 하위 시나리오 5개도 통과했다.
- 컴파일 worker TLS 회수(성공/오류)와 thread 제한 Rust 테스트 2개 통과.
- 호스트·데스크톱·벤치마크·공통 어댑터 타입 검사 통과.
- 앱 패키지와 모듈 패키지는 사용자 설치/권한을 자동 변경하지 않고 별도로 제공한다.

### 최종 배포 산출물

- 앱: `build/packages/maghemite-0.1.0-10-x86_64.pkg.tar.zst`, 225,790,512 bytes.
- 앱 SHA-256: `43981b8f94c1294d1af0953a4518c0e44d6501a79c378ea0c3cb125d6246c31a`.
- 패키지 내부 Wasmtime 호스트와 빌드 호스트의 SHA-256 일치: `d4d7a5e86054c66fb86bdac7cf8ff90262ae937fd120eb8e5e4a5575789d2c22`.
- `build/modules/javascript`, `build/modules/cpp`: alpha.2. SDK import 경로 재배치 후 공통 어댑터 소스 일치, WASM SHA-256 일치 확인.
- 렌더러 production build 및 Deno Desktop 패키징 성공. 기존 번들 크기 경고가 남는다. 이 변경에서 새 GUI 세션을 통한 시각 회귀 검증은 수행하지 않았다.
