# Native helper foundation

Build: `node scripts/native-build.mjs`. Check only the noninteractive handshake:
`node scripts/native-smoke.mjs`.

The helper runs as `resources/native/one-room-helper --stdio`. Main sends a
JSONL v1 `hello` command with a UUID session, UUID request ID, generation,
nullable observation/pid/window IDs, issued/deadline timestamps, and
`payload: { "role": "executor" }` (or `listener`). It returns the same identity,
permissions and separate capability states. Permission probes never prompt.

`hello`, `status`, `permissions.request`, `shutdown`, `frontmost`, `capture.preflight`, `observe`,
`capture`, `extract`, `ocr`, and `cancel` are implemented. `frontmost` never
reads a title; main first checks bundle scope, then sends explicit pid/windowId
and observation identity for capture/extraction. Preflight rejects ambiguous,
minimized, offscreen or overlapped candidates and never captures an image.
`preflight_candidate` is not a completed screenshot or an authorization decision.

Only an explicit `permissions.request` command prompts for the selected
`screen`, `accessibility`, or `inputMonitoring` permission. Main sends it when
the corresponding settings button is clicked, then opens the macOS pane.
The request does not capture content or start a listener. Local app packages
are fully ad-hoc signed with the One Room bundle identity; Developer ID and
notarization are separate release requirements.

For an executor, main creates a private directory and passes its canonical
absolute path as `hello.payload.stagingRoot`. Capture writes only
`<stagingRoot>/<outputToken>.png` with a UUID token and returns PNG size/hash,
observedAt and pre/post contexts; the protocol never returns a filesystem path.
Main validates and persists facts before dispatching extraction. OCR reads the
same original image through a UUID inputToken, without recapturing a new window.
Main owns committed evidence, staging lifetime, scope and generation checks.

The listener role accepts `observe` with `policyRevision`, trigger names,
`heartbeatMs`, `allowedBundleIds` and `excludedBundleIds`. It sends initial and
changed context signals, heartbeat, lock/sleep transitions, and aggregate click,
typing-pause and scroll-stop timings. It never reads characters, key codes or
clipboard text; excluded contexts emit only a blocked stop signal. Listener
processes reject capture and extraction so their lifetime is separate from AX
and OCR executors. Permission probes never request TCC authorization.

AX extraction traverses only the matched window with depth/node/text/time
budgets, safe-role filtering and visible geometry/character ranges. Thin,
partial and empty outcomes remain distinct. Vision OCR uses accurate local
Chinese/English recognition. Both return structured source and completeness.
Main terminates an executor if an OS call exceeds its deadline.

The foundation compiles in Swift 5 mode for arm64 macOS 14.0. Output belongs
outside ASAR through Electron Builder `extraResources`; release builds must
replace the local ad-hoc signature with the application signing identity before
notarization. Main owns helper lifetime, timeouts, generation, staging and
persisted evidence. No arbitrary paths, shell commands or database writes are
accepted by the helper.

`WindowContext.swift`, `WindowListener.swift`, PNG encoding in
`WindowCapture.swift`, and `VisionOCR.swift` adapt locked MemoryLane v1.5.10
code under GPL-3.0-or-later. See source comments, the root third-party notice and
retained license.

`node scripts/native-smoke.mjs --fixture` additionally compiles and activates an
isolated Cocoa test window, then checks only that window's screenshot/hash,
AX text, Chinese/English OCR, initial listener signal and heartbeat. It uses a
higher test window level to avoid existing desktop overlay tools and places the
fixture away from the pointer; it never skips overlapping surfaces in product
visibility checks. Ordinary windows can remain blocked while a full-screen
overlay is present. Generated screenshots and test processes are cleaned up.
Second-Mac, Developer ID/TCC, real input timing and gesture checks remain separate.

For the production TypeScript/Zod protocol and coordinator/storage chain, run
`npm run build`, then
`ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron out/main/nativeCaptureSmoke.js`.
This uses the same isolated Cocoa fixture, a private temporary SQLite/evidence
directory, fixture-only capture scope and disabled model sends. It checks real
NativeSession responses/events, AX/OCR, screenshot hashes, coordinator activity
commits, pause and persisted restart. See `docs/acceptance/capture.md` for the
single-Mac result and pending acceptance gates.

The expanded fixture additionally checks protocol budgets, controlled
overlay/offscreen/minimized rejection, three-app AX/OCR and
capture-to-report/delete behavior. The recorded complete controlled-window run
is in `docs/acceptance/capture.md`; it does not prove ordinary desktop
visibility. The fixture must remain frontmost throughout each checked capture;
focus changes are rejected. Directed `CGEvent.postToPid` injection has not been
observed by the global input monitor, so physical/global input acceptance
remains pending.
