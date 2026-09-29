# Deno와 Rust/WASM 모듈의 동일 작업 비교 — 2026-09-27

## 결론

기존 측정은 WASM 최적화 전후 또는 서로 다른 실제 언어 도구의 비용이었다. Deno와 WASM이 같은 일을 하는 비교는 이번에 처음 수행했다. 따라서 이 자료 이전에 Deno 중계 계층의 WASM 이식이 성능상 유리하다고 결론 내릴 근거는 충분하지 않았다.

이번 작은 SDK 모듈에서는 **WASM이 워커 메모리와 작은 호출의 지연에서 유리했다. 정수 연산은 Deno와 WASM 계산용 프로파일이 비슷했고, WASM 표준 프로파일은 오히려 느렸다.** 캐시가 비어 있으면 WASM의 첫 응답도 Deno보다 느렸다. 결과는 이 두 구현과 현재 SDK/호스트 정책의 비교이며 런타임 전체의 보편적인 우열을 나타내지 않는다.

## 측정 조건

- Linux x86_64, Intel Core Ultra 9 185H, 논리 CPU 22개, kernel 7.2.8-1-cachyos.
- Deno 2.9.7, Rust 1.97.1 release, Wasmtime 49.0.1.
- Deno TypeScript와 Rust/WASM Component Model에 같은 명령 네 개를 구현했다. 앱의 실제 ModuleHost, 프로세스 격리, JSON 전송, SDK 바인딩, 권한 검사와 제한을 통과한다.
- `echo`: 약 800-byte Unicode JSON의 입출력. `callbacks`: 같은 JSON과 동시에 시작해 모두 기다리는 progress 콜백 2개. `compute`: 입력 seed를 사용하는 같은 xorshift32 루프 100만 회. `text`: 같은 22 KiB ASCII 문서에서 같은 공백 규칙으로 단어 수 계산.
- 각 호출의 결과와 콜백 개수를 검증했다. 측정·워밍업·첫 호출 합계 16,025개 결과가 일치했고, 별도 캐시 준비 호출도 성공했다.
- 매번 부모 Deno 호스트와 모듈 프로세스를 새로 시작했다. 다섯 변형(Deno, WASM standard cold/warm, WASM compute cold/warm)을 실행 순서를 회전하며 각각 5회씩, 총 25회 실행했다.
- workload별 워밍업 20회 후 echo/callbacks 각각 200회, compute 60회, text 100회 측정. 아래 호출 지연은 다섯 실행의 표본을 합친 p50. p95와 개별 표본도 원시 JSON에 있다.
- Wasmtime cold는 빈 임시 컴파일 캐시, warm은 미리 준비한 캐시다. OS 파일 캐시와 Deno 캐시는 비우지 않았다. 따라서 Deno의 시스템 전체 cold boot와 비교한 수치는 아니다.
- 기존 standard/compute의 fuel, yield, 메모리, timeout 정책을 모두 유지했다. standard의 yield 간격은 10,000 fuel, compute는 100,000 fuel이며 총 연료와 메모리 한도도 기존 정책 그대로다. 이번 입력은 두 프로파일 모두 한도 안에서 완료됐다.
- 실제 LSP 엔진, 대규모 프로젝트, 장시간 GC/할당, 네트워크·파일 I/O·병렬 실행, CEF/렌더러/GPU/PTY/인덱서는 비교하지 않았다. 강제 GC, CPU 고정, 다른 데스크톱 프로세스 중단도 하지 않았다.

## 결과

표의 WASM 열은 컴파일 캐시가 준비된 경우다. 메모리는 동일한 전체 작업 순서를 끝낸 상태의 중앙값이다.

| 항목 | Deno / TypeScript | WASM / Rust standard | WASM / Rust compute |
| --- | ---: | ---: | ---: |
| 프로세스 시작·활성화·첫 응답 | 27.025 ms | 12.655 ms | 12.437 ms |
| 단순 JSON 왕복 | 0.245 ms | 0.147 ms | 0.142 ms |
| 동시 호스트 콜백 2회 + 왕복 | 0.367 ms | 0.275 ms | 0.284 ms |
| 동일 정수 루프 100만 회 + 왕복 | 3.013 ms | 3.914 ms | 2.994 ms |
| ASCII 문서 22 KiB 단어 스캔 + 왕복 | 0.403 ms | 0.442 ms | 0.356 ms |
| 전체 작업 후 워커 RSS | 56.984 MiB | 16.074 MiB | 15.688 MiB |
| 전체 작업 후 워커 PSS | 35.125 MiB | 13.727 MiB | 13.348 MiB |
| 부모 호스트 + 워커 합산 PSS | 80.11 MiB | 66.25 MiB | 64.50 MiB |

- **WASM 캐시 miss:** 첫 응답 중앙값 standard 84.61 ms, compute 84.29 ms. Deno의 27.02 ms보다 느렸다. 캐시 hit의 약 12.5 ms를 첫 설치 비용으로 제시하면 안 된다.
- **메모리:** 캐시가 있는 WASM 워커의 RSS는 약 16 MiB, Deno는 약 57 MiB였다. 하지만 RSS는 공유 페이지를 중복 포함한다. 부모까지 합친 이 측정의 PSS는 약 80 MiB 대 65–66 MiB로, 워커 RSS 비율을 전체 앱 절감률로 환산하면 안 된다.
- **CPU 연산:** Deno 약 3.01 ms, WASM standard 약 3.91 ms, compute 약 2.99 ms. compute와 Deno의 작은 차이로 우열을 주장하지 않는다. 프로파일 간 실행 양보 정책의 영향이 관측됐다. 이는 산술 연산 속도만 격리한 결과가 아니라 SDK 왕복을 포함한다.
- **작은 호출:** WASM의 JSON 왕복 p50 약 0.14–0.15 ms, Deno 약 0.25 ms. 절대 차이는 약 0.1 ms이며 실제 큰 분석 엔진의 성능 차이로 확대 해석하지 않는다.
- **호스트 콜백:** 두 경로 모두 동일한 Deno 부모의 API와 권한 브로커를 사용한다. 이 비용은 WASM을 선택해도 남는다.
- **CPU 사용량:** Linux CPU tick이 10 ms 단위이므로 짧은 작업의 CPU 차이는 거칠다. compute 60회 동안 워커 CPU 중앙값은 Deno 170 ms, standard 230 ms, compute 170 ms였다. 부모 CPU는 각각 약 20 ms. 원시 카운터는 메모리 관측 사이에 기록돼 일부 측정 오버헤드가 포함된다.

## Deno Desktop 백엔드의 역할과 설계 판단

현재 백엔드는 문서·설정·작업공간·권한·모듈 수명·서비스 요청·IPC를 관리한다. 별도 Deno 모듈 프로세스는 개발자가 작성한 코드를 격리하는 실행 환경이다. 이번 워커 비용을 이미 동작 중인 앱 백엔드 전체의 비용과 동일시하면 안 된다.

권장 방향은 다음과 같다. 이 측정에서 실행 구조 자체를 바꾸지는 않았다.

1. 앱이 소유하는 공통 LSP 중계, 요청 스케줄링, 문서 버전·결과 변환은 기존 Deno 백엔드에서 공유하는 방향을 검토한다. 각 패키지가 같은 중계 코드를 위해 별도 Deno 프로세스를 요구하는 비용과 IPC 단계를 줄일 수 있다. 실제 언어 도구로 후속 측정해야 한다.
2. 사용자 작성 JS/TS 모듈은 계속 Deno SDK 경로로 지원하고 권한·장애 경계를 유지한다. 자동화·API 조합·도구 연결에도 적절한 경로다. 네트워크/파일 I/O 효율 우위는 이번 측정으로 검증한 주장이 아니다.
3. WASM 모듈은 다양한 언어의 컴퓨팅 엔진과 낮은 기본 메모리 비용을 활용하되, 무거운 JIT와 엔진별 메모리는 별도로 관리한다. 같은 호스트 안에서 Engine을 공유하는 구조는 이번에 측정하지 않았다.
4. 테마와 선언형 템플릿은 설정·리소스로 배포한다. 이 비교를 근거로 이들에 실행기를 붙이지 않는다.
5. 두 경로의 API 의미·권한·취소·진단·패키징은 같은 SDK 계약을 유지한다. Deno 중계 코드를 모두 WASM으로 옮기는 것을 일괄 최적화 규칙으로 삼지 않는다.

## 재현

리포지토리의 기존 도구 체인을 사용한다. 사용자 모듈 설치 목록, 권한, 앱 패키지는 바뀌지 않는다.

```sh
cd modules-sdk/performance/runtime-comparison/wasm
cargo build --locked --offline --release --target wasm32-wasip2
cd ../../../..
deno run --check -A modules-sdk/tooling/compare_runtimes.ts --output=/tmp/deno-vs-wasm.json
```

이 환경에서는 Cargo 캐시가 `build/cargo-home`에 있으므로 필요하면 `CARGO_HOME`을 그 절대 경로로 지정한다. 측정은 임시 디렉토리에 WASM 파일을 복사해 프로파일을 분리하고 종료 시 캐시와 함께 제거한다.

[원시 측정값·분위수·CPU·메모리·바이너리 해시](deno-vs-wasm-2026-09-27.json)

소스: `modules-sdk/tooling/compare_runtimes.ts`, `modules-sdk/performance/runtime-comparison/{deno,wasm}`.
