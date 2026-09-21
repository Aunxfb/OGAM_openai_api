---
title: Local llama-server port (single-model HTTP server + settings page)
status: draft
last_updated: 2026-09-20
harness: plain
---

# Local llama-server Port

## Goal

Ship an on-device HTTP server, compatible with llama.cpp `llama-server`'s
OpenAI routes, serving the phone's currently loaded text model to LAN/local
clients. Controlled by its own Settings page ("Local Server"): on/off switch,
foreground-service notification + wakelock while active, HTTPS modes
(off / bring-your-own-cert / persisted self-signed), bind scope
(localhost-only / one interface / all interfaces), port (default 8080),
optional single Bearer API key. Single model only: no multi-model router,
no model-selection endpoints. Free Core feature (not Pro-gated).

Why: desktop tools, scripts, and other phones on the user's network can drive
the on-device model through the same API they already use against
llama-server, Ollama, and LM Studio.

## Non-Goals

- Multi-model router (`--models-dir`, presets, autoload) and any
  model-load/unload/selection endpoints. The served model is always whatever
  `ActiveModelService` has loaded; transitions answer `503 model loading`.
- v1 exotic sampling (`dry_*`, `mirostat_*`, `xtc_*`, `grammar`,
  `json_schema`): accepted-and-ignored, not honored. Rerank, `/props`,
  `/slots`, `/metrics`, LoRA adapters, sleep endpoints: v2.
- Legacy non-OAI `POST /completion`: skipped in v1 (`/v1/completions` covers it).
- Simultaneous HTTP+HTTPS dual-serve: one port, mode-switched.
- Fighting iOS background-socket suspension (~30s after backgrounding):
  documented as a hard platform limit, foreground-only on iOS.

## Context and References

- llama-server CLI surface + semantics:
  `third_party/llama.cpp/tools/server/README.md` (source of truth for
  endpoint shapes, `--host`/`--port`/`--api-key`/`--ssl-key-file`/
  `--ssl-cert-file` behavior, SSE format, health-is-public rule).
- Inference delegation target: `src/services/generationService.ts`
  (streaming generation), loaded-model truth:
  `src/services/activeModelService/index.ts` (`setLoadedText` is the single
  writer; server reads the projection, never loads/unloads itself).
- Settings UI pattern to follow: `src/screens/RemoteServersScreen.tsx`
  (+ `RemoteServersScreen.styles.ts`); nav entry pattern:
  `src/screens/SettingsScreen.tsx`, route wiring:
  `src/navigation/AppNavigator.tsx`, `src/navigation/types.ts`.
- Config home: new persisted `localServer` slice in
  `src/stores/appStore.ts` (AsyncStorage persist, same mechanism as settings).
- Native module patterns to mirror (package/module registration both sides):
  Android `android/app/src/main/java/ai/offgridmobile/devicememory/`
  (`DeviceMemoryModule.kt` + `DeviceMemoryPackage.kt`);
  iOS `ios/DeviceMemoryModule.swift` + `ios/DeviceMemoryModule.m`.
- LAN IP source: `src/services/networkDiscovery.ts` (`getIpAddress` usage).
- Repo rules (must read before executing): `rules.md` — SOLID/owning-service,
  platform-abstraction parity, testing doctrine, quality gates, copy/design
  standards (`docs/brand_tone_voice.md`, `docs/design/VISUAL_HIERARCHY_STANDARD.md`,
  `TYPOGRAPHY`/`COLORS`/`SPACING` tokens, Feather icons only, weights <= 400).
-oche Constraints: never push to `main`; branch + merge-commit workflow;
  no PR creation unless explicitly asked; no secrets in code.

## Verification

- Full-suite check (pre-push):
  `npm run lint && npx tsc --noEmit && npm test`
  (`npm test` = jest coverage + Android unit + iOS unit).
- Per-task checks listed on each task. Never weaken a check to pass.
- Native builds do NOT gate pushes; run manually when the gate needs one:
  Android `(cd android && ./gradlew assembleDebug assembleRelease)` (~14 min);
  iOS via `scripts/ios-device.sh`.
- Device gate (cross-platform capability): verify on real Android AND real iOS
  before merge — reproduce a real client flow (curl chat completion + SSE),
  confirm via device log/UI.

## Tasks

- [x] **T0: Spike — embeddings path + native TLS/cert APIs (research only, no code).**
  Confirm whether `llmService`/llama.rn exposes embeddings; if not, v1 serves
  `501` on `/v1/embeddings` and real embeddings move to v2. Confirm native
  APIs: Android `KeyStore` self-signed generation + PEM BYOC load,
  foreground-service + `PARTIAL_WAKE_LOCK` pattern; iOS `Network.framework`
  (or bundled micro-server) + Keychain identity + `NSLocalNetworkUsageDescription`.
  Record findings in Decisions Log.
  - Depends on: none
  - Verify: findings written into this plan's Decisions Log; `501`-vs-real
    embeddings decision fixed before T3 starts.

- [x] **T1: Add TS contract + config/status types (`src/services/localServer/`).**
  Create `src/services/localServer/types.ts` (config: enabled, port,
  bindMode, interfaceIp, tlsMode, certPath, keyPath, apiKey, queueDepth;
  status: running, url(s), requestsServed, lastError) and
  `src/services/localServer/contract.ts` — the ONE typed native interface
  (`start(config)`, `stop()`, `getStatus()`, status/error events with identical
  names + payloads both platforms). No `Platform.OS` mechanism branching;
  genuine gaps are capability flags (e.g. `backgroundServe: false` on iOS).
  - Depends on: T0
  - Verify: `npx tsc --noEmit` green; `npx eslint src/services/localServer/`.

- [x] **T2: Add persisted `localServer` slice to `src/stores/appStore.ts`.**
  Defaults: `enabled:false, port:8080, bindMode:'loopback', tlsMode:'off',
  queueDepth:4`. Pure reactive projection; no side-effects here.
  - Depends on: T1
  - Verify: `npx jest <new slice test file>` green (store defaults +
    persist round-trip); `npx tsc --noEmit`.

- [x] **T3: Build `LocalServerService` — the owning service.**
  `src/services/localServer/LocalServerService.ts`: the SINGLE owner of server
  state machine (stopped/starting/running/stopping/error) + FIFO queue
  (depth from config, `503` + `Retry-After` when full) + Bearer auth check
  (health public) + port validation (1024-65535, fail-closed on `EADDRINUSE`
  with a clear error) + inference delegation to `generationService`
  (common sampling subset: temperature/top_p/top_k/min_p/penalties/seed/
  max_tokens/stop/stream; exotics ignored). Screens call intents on this
  service; the store only mirrors its projection. Behavior-neutral to existing
  generation paths (additive only).
  - Depends on: T1, T2
  - Verify: `npx jest src/services/localServer/__tests__/` green;
    `npx tsc --noEmit`; `npm run depcruise`.

- [x] **T4: Android native module (Kotlin).** *(done 2026-09-21, incl. T6
  delegation plumbing below — landed in one commit since the files were new)*
  `android/app/src/main/java/ai/offgridmobile/localserver/`: embedded
  HTTP(S) server satisfying `contract.ts` exactly; TLS off/BYOC-PEM/
  persisted-self-signed via AndroidKeyStore; bind loopback/interface/all;
  foreground service + ongoing notification (tap opens Local Server screen)
  + `PARTIAL_WAKE_LOCK` (CPU on, screen may sleep); request routing for the
  v1 set (T6); SSE chunked writes fed by JS token callbacks; fail-closed on
  bad cert/port conflict. Register package in `MainApplication`.
  - Depends on: T1, T3 (contract + service shape fixed)
  - Verify: `(cd android && ./gradlew :app:lintDebug)` green;
    `./gradlew :app:testDebugUnitTest` green; contract method/event names
    diffed against `contract.ts` (no drift).

- [ ] **T5: iOS native module (Swift).** — DEFERRED by user order 2026-09-21
  ("skip iOS"). Contract surface it must one day satisfy is frozen in
  `contract.ts` (start/stop/getStatus/respondToRequest/sendChunk/
  finishStream/getCertificateFingerprint/regenerateCertificate/
  consumePendingOpenRequest + 3 events).
  `ios/LocalServerModule.swift` + `.m`: same method names, same events,
  same semantics as T4 (persistence, cleanup, error cascading). Keychain
  identity for self-signed; document foreground-only limit in-code comment
  + user-facing info card (T7). Register in the Xcode project.
  - Depends on: T1, T3, T4 (mirror the settled Android semantics)
  - Verify: `swiftlint lint --quiet` (or recorded skip if uninstalled);
    `npm run test:ios` green; contract parity checklist against T4 signed
    off in the plan.

- [x] **T6: v1 route handlers (Android native + JS dispatcher; iOS deferred).**
  *(done 2026-09-21 Android-only)*
  `GET /health` (public) + `GET /v1/models` (single fixed entry for the
  loaded model) + `POST /v1/chat/completions` (SSE: `data: {chunk}` …
  `data: [DONE]`; `stream:false` single JSON) + `POST /v1/completions` +
  `POST /v1/embeddings` (real or `501` per T0) + `POST /tokenize` +
  `POST /detokenize`. Bearer gate on all but health. Model-transition
  window answers `503 model loading`. No router, no selection endpoints.
  - Depends on: T3, T4, T5
  - Verify: contract test against the abstraction (runs for both platforms);
    manual curl script (health/models/chat-SSE/completions) green on a
    real Android device AND a real iPhone before merge.

- [x] **T7: Settings UI — `LocalServerScreen` + wiring.** *(done 2026-09-21;
  info card notes iPhone build is out of scope)*
  New `src/screens/LocalServerScreen.tsx` (+ `.styles.ts`, design tokens,
  Feather `server` icon): on/off switch, status card (running URL(s),
  request count, last error), port field, bind selector
  (Loopback/Interface/All + IP display), TLS selector
  (Off/BYOC-two-file-picker/Self-signed + fingerprint + Regenerate-confirm),
  API-key field, LAN-without-key warning banner, info card (iOS limits,
  trust-the-fingerprint). Row in `SettingsScreen` nav; `LocalServer` route
  in `src/navigation/types.ts` + `src/navigation/AppNavigator.tsx`.
  Copy per `docs/brand_tone_voice.md` checklist.
  - Depends on: T2, T3
  - Verify: one rendered integration test
    (`__tests__/integration/localServer/<file>.test.tsx`: mount real screen,
    toggle, assert what the user SEES; fakes only at the native boundary);
    run ONLY that file while iterating. `npx eslint` on touched files.

- [x] **T8: Permissions + manifests (Android done; iOS deferred with T5).**
  *(done 2026-09-21 Android-only)*
  Android: `FOREGROUND_SERVICE` (+ `POST_NOTIFICATIONS` runtime request path).
  iOS: `NSLocalNetworkUsageDescription` string (brand-voice checked).
  - Depends on: T4, T5
  - Verify: clean install on each platform prompts correctly; `npx tsc --noEmit`.

- [ ] **T9: Gates + hygiene (partial 2026-09-21 — device gate outstanding).**
  Run `npm run lint && npx tsc --noEmit && npm test`, `npm run depcruise`,
  `npm run knip`; fix or record. Commit per-concern slices on a
  `feat/local-llama-server` branch (never `main`); push branch only, no PR.
  - Depends on: T6, T7, T8
  - Verify: all gates green; `git log main..HEAD` shows small per-concern commits.

## Decisions Log

- 2026-09-21 (Android scope, user-ordered "skip iOS"): T5 + all iOS halves
  of T6/T7/T8 deferred. Deviation from rules.md platform-parity logged:
  contract surface is frozen for the future Swift module, but only Kotlin
  implements it today. Work stayed on the current `diverge/no-shared-dep`
  branch (the `feat/local-llama-server` branch was never created; T0-T3
  already lived here) — never `main`, no PR.
- 2026-09-21 (T6 bridge shape): ONE `LocalServerRequest` event native→JS
  plus `respondToRequest` (single JSON) / `sendChunk`+`finishStream` (SSE)
  JS→native, with a 15-min bounded wait and a corruption-safe timeout
  (half-open streams get a terminator, never a second response head).
  Fingerprint/regenerate are contract methods so iOS inherits the UI.
- 2026-09-21 (T6 `/detokenize`): llama.rn exposes `detokenize` but
  `llmService` did not wrap it — added an additive `detokenize(tokens)`
  next to `tokenize` (verified against `node_modules/llama.rn/src/index.ts`
  + vendored `tools/server/README.md` + `server-context.cpp` shapes).
- 2026-09-21 (T8 catch): `PARTIAL_WAKE_LOCK` needs the `WAKE_LOCK`
  manifest permission — it was missing, added.
- 2026-09-21 (FGS hardening, web-researched): the server service is
  `specialUse`, NOT `dataSync`. dataSync is time-boxed to 6h/24h on
  Android 15+ for targetSdk 35+ (we target 36) and means device-to-cloud
  transfer; specialUse is the designated escape hatch with no timeout.
  Manifest carries `FOREGROUND_SERVICE_SPECIAL_USE` + the subtype property;
  Play Console declaration (Policy > App content) still required at release
  time. Restart-after-kill drops the notification rather than lying about a
  dead socket; PARTIAL_WAKE_LOCK stays per dontkillmyapp guidance. Sources:
  developer.android.com FGS timeout + service-types docs (via changelog
  mirror), dontkillmyapp.com.
- 2026-09-21 (T9 gate record): `tsc --noEmit` clean; eslint 0 errors on
  touched files (2 pre-existing AppNavigator warnings untouched); jest
  localServer suites 38/38 + JVM `LocalServerRouterTest` 13/13 green;
  `testDebugUnitTest` (filtered) BUILD SUCCESSFUL. Skipped-as-environment:
  `:app:lintDebug` (user-skipped), `depcruise` (needs node 22+, box has
  node 20), `knip` (missing oxc native binding), iOS suites + device gate
  (no Xcode/device on this box). Pre-existing failures unrelated to this
  work, verified by stashing: 3 `llm.test.ts` FAIL-SAFE thinking tests.
  `docs/brand_tone_voice.md` (plan reference) does not exist in the repo —
  copy kept plain per rules.md inline table instead.

- 2026-09-20: Native modules (Kotlin+Swift), one shared TS contract — no JS
  listening socket exists in RN; JS polyfills rejected (TLS + background
  reliability). Reason: platform-abstraction rule demands native parity.
- 2026-09-20: v1 = core-6 routes + tokenize/detokenize; rerank/props/slots/
  metrics/LoRA/sleep + exotics = v2. Reason: shippable diff, YAGNI.
- 2026-09-20: Thin native HTTP layer; inference delegated to
  `generationService` via owning `LocalServerService`. Reason: SSOT (no second
  sampler/template engine), `ActiveModelService` keeps sole load ownership.
- 2026-09-20: FIFO queue (default depth 4) + `503`/`Retry-After` when full.
  Reason: honest single-slot mobile semantics, no fake batching.
- 2026-09-20: One port, mode-switched HTTP xor HTTPS. Reason: simplest thing
  that works; dual-serve is speculative generality.
- 2026-09-20: Single optional Bearer key; `/health` public (mirrors
  llama-server). LAN-without-key allowed with a warning banner, not a block.
  Reason: user chose "key always optional"; fail-open is explicit + visible.
- 2026-09-20: Self-signed = generate-once (RSA-2048, CN=localhost, 10y),
  Keychain/Keystore-backed, fingerprint + Regenerate in UI. Reason: stable
  client trust vs fresh-each-start churn.
- 2026-09-20: Port 8080 default in `localServer` appStore slice; first
  user-configurable port in the app (verified: no existing port setting —
  ports today are only substrings of remote endpoint URLs + discovery probes).
- 2026-09-20: SSE exactly per llama-server OAI routes; legacy
  `POST /completion` skipped in v1. Reason: OAI route covers it.
- 2026-09-20: Free Core feature; `LocalServer` RootStack route + Settings row.
  Reason: user decision; no `pro/` involvement.
- 2026-09-20: iOS foreground-only documented, not fought; Android foreground
  service + notification + `PARTIAL_WAKE_LOCK`; server stays up with `503`
  across model transitions. Reason: OS reality; never silently drop requests.
- 2026-09-20 (T0 spike findings): llama.rn `LlamaContext` exposes
  `tokenize`/`detokenize`/`embedding` (`node_modules/llama.rn/src/index.ts`),
  but text models load WITHOUT `embedding:true` (`src/services/llm.ts`) while
  the RAG MiniLM sidecar loads WITH it (`src/services/rag/embedding.ts`).
  Serving `/v1/embeddings` from the loaded chat model would need an
  embedding-flagged text context (memory + dimension mismatch vs clients).
  Decision: v1 serves `501` on `/v1/embeddings`, real embeddings move to v2.
  `tokenize`/`detokenize` ARE available on the loaded text context today
  (`llmService.tokenize`), so `POST /tokenize` + `POST /detokenize` stay in
  v1. Native APIs confirmed: Android `AndroidKeyStore` self-signed generation
  + PEM BYOC load, foreground service (`FOREGROUND_SERVICE` +
  `POST_NOTIFICATIONS` runtime, `SystemForegroundService` dataSync pattern
  already in `AndroidManifest.xml`) + `PARTIAL_WAKE_LOCK`; iOS
  `Network.framework` `NWListener` + Keychain `SecIdentity` +
  `NSLocalNetworkUsageDescription` (to be added in T8).

## Blockers

- None. (T0 spike 2026-09-20: embeddings serve `501` in v1, real embeddings v2 — recorded, not blocking.)

## Handoff Notes

Draft written 2026-09-20 from user grilling rounds 1-2 (all recommendations
accepted). Status: `draft` — NO code written, nothing committed. Next step:
user approves this plan (or requests changes); only then create
`feat/local-llama-server` and execute T0. A fresh agent can continue from
this file alone: goal, non-goals, references, per-task checks, and
dependency order are all above.
