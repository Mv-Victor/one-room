# Third-Party Notices

One Room is distributed under GPL-3.0-or-later; see the root `LICENSE`.
This public source distribution includes code adapted from MemoryLane and
Screenpipe. Their original license texts, upstream revisions and modification
notices are retained below. Third-party components retain their respective
copyright notices and licenses.

OpenAdapt Flow 2.0.0 is used as an actual local Python recording/compiler/replay dependency,
not a reimplementation. Source inspected at 04fe6febda81cd611581612980056ae195f476a2:
https://github.com/OpenAdaptAI/openadapt-flow . Distribution licenses and metadata
are retained in the bundled site-packages/*.dist-info directories. One Room adds
the owned-browser bridge, immutable artifact binding, Chinese UI and independent
read-only result checks; no OpenAdapt cloud upload, paid model or simulated agent is used.

## Incorporated source

### MemoryLane

- Repository: https://github.com/deusXmachina-dev/memorylane
- Version: v1.5.10
- Commit: `f3157d54524e647d32f7decd186ee00cac9f72d5`
- License: GPL-3.0-or-later. Original text: `specs/001-event-driven-capture/licenses/memorylane-GPL-3.0.txt`.
- Source: `src/main/recorder/swift/app-watcher.swift`, lines 22-79.
- Adapted into: `native/WindowContext.swift`, `focusedWindow` and focused-window frame extraction.
- Changes: bounded AX messaging timeout, permission preflight, checked CF types, no title/URL traversal, and JSONL v1 context/preflight wrapping.
- Source: `src/main/recorder/swift/app-watcher.swift`, lines 285-465.
- Adapted into: `native/WindowListener.swift`, NSWorkspace activation notifications and AXObserver setup/cleanup.
- Changes: notification-only JSONL events, allowed/excluded application scope, no title/URL/body reads in event callbacks, bounded heartbeat, and lock/sleep lifecycle signals.
- Source: `src/main/recorder/swift/screenshot.swift`, lines 87-115.
- Adapted into: `native/WindowCapture.swift`, PNG image-destination encoding.
- Changes: specified-window single screenshot, pre/post window identity and visibility checks, in-memory encoding with size limits, and output-token staging instead of arbitrary destination paths.
- Source: `src/main/processor/swift/ocr.swift`, lines 28-54.
- Adapted into: `native/VisionOCR.swift`, Vision request/recognition/result extraction.
- Changes: original-image input token, Chinese/English accurate recognition, bounded text, structured source/status/completeness and no image upload.
- The remaining context validation and protocol code are One Room integration code. The adapted Swift files carry GPL-3.0-or-later identification. Upstream license and source attribution are retained in this GPL-3.0-or-later public source distribution (2026-10-22).
- Source: `src/main/recorder/native-screenshot.ts`, lines 123-172, process spawn/stdin/error lifecycle.
- Adapted into: `src/services/capture/helper-client.ts`.
- Changes: single read-only hello/shutdown inspection, strict JSONL schema and identity validation, bounded output and diagnostics, five-second hard timeout, and no automatic restart or screen capture.
- Source: `src/main/settings/vendor-credentials-manager.ts`, lines 8-12, 123-133 and 263-277.
- Adapted into: `src/services/model/config-store.ts`, injected safeStorage encryption, base64 ciphertext persistence and decryption.
- Changes: one model endpoint; removed vendor migration, environment keys, plaintext credential cache and logging. Added strict stored-config validation, serialized revision checks, private file permissions and atomic file replacement. Public reads return credential presence only.

### Screenpipe

- Repository: https://github.com/screenpipe/screenpipe
- Version: v2.2.243
- Commit: `1b3e4186ec5a624b95a581c7187c1d48284bea9a`
- License: MIT for the selected files outside `ee/`.
- Original text: `specs/001-event-driven-capture/licenses/screenpipe-MIT.txt`.
- Source: `apps/screenpipe-app-tauri/components/rewind/timeline/timeline-controls.tsx`, lines 145-173.
- Adapted into: `src/renderer/timeline/TimelineControls.tsx`, previous/next-day navigation and future-date bounds.
- Changes: component props and Shanghai day keys replace the Tauri/store/date-fns dependencies; Lucide buttons and a native date input serve the foundation UI.
- Source: `apps/screenpipe-app-tauri/components/rewind/hooks/use-frame-loading.ts`, lines 314-351 and 466-502.
- Adapted into: `src/renderer/timeline/hooks/use-evidence-image.ts` and `use-contained-image-layout.ts`.
- Changes: image preload/cancellation and ResizeObserver/contain/RAF cleanup; controlled evidence URLs and revision/period scopes replace Tauri assets. During a scrub, the preceding loaded image may remain only within the same valid period and source revision, with its actual observation timestamp. Missing, deleted, expired, future or out-of-period evidence clears immediately.
- Source: `apps/screenpipe-app-tauri/components/rewind/hooks/use-scroll-zoom.ts`, lines 78-92.
- Adapted into: `src/renderer/timeline/hooks/use-smooth-zoom.ts`.
- Changes: RAF interpolation applies to elapsed time rather than frame indexes; reduced-motion support and local cancellation. This is a smooth-transition helper, not proof of physical three-finger gesture support.
- Source: `apps/screenpipe-app-tauri/components/rewind/hooks/use-scroll-zoom.ts`, lines 95-183.
- Adapted into: `src/renderer/timeline/TimelineView.tsx`, `navigation.ts` and `hooks/use-sampled-cursor.ts`.
- Changes: scoped wheel input, zoom-scaled navigation and RAF scheduling operate on elapsed timestamps rather than frame indexes. One Room coalesces all input arriving within one animation frame, normalizes horizontal/vertical pixel/line/page deltas, bounds cursor resolution to one sample per 60ms, and leaves activity lists and calendar cells with native scrolling. No Tauri listener, lodash throttle or global wheel interception is copied.
- Source: `apps/screenpipe-app-tauri/components/rewind/timeline/timeline.tsx`, lines 805-828.
- Adapted into: `src/renderer/timeline/TimelineView.tsx` and `navigation.ts`, selected-time centering.
- Changes: a fixed 50% playhead and a time range centered on that instant replace frame-element `scrollIntoView`. Navigation uses the actual recording bounds and can cross midnight; blank padding outside the recording does not create observations. Sparse recordings auto-fit to a useful scale instead of a full calendar day. The frame-width/visible-window calculation at lines 455-502 was also reviewed as a behavior reference; One Room retains proportional elapsed-time widths. The 320ms fading/tilting day/month planes in `hooks/use-review-transition.ts` and `src/renderer/worklog.css` are original One Room integration, with reduced-motion support and no animation runtime dependency.
- Source: `apps/screenpipe-app-tauri/components/rewind/timeline/timeline.tsx`, lines 619-706.
- Adapted into: `src/renderer/timeline/group-period-runs.ts`.
- Changes: contiguous run/flush structure only; One Room additionally compares time continuity, day, object/topic and gaps, while preserving each input period and short switches.

## Research excerpts and later adaptation candidates

Screenpipe at the fixed version and commit above:

- Exact current research excerpts: `specs/001-event-driven-capture/code-excerpts.md` (SP-1, SP-2, SP-3).
- Selected small blocks for image cancellation/contain (R1), date navigation (R2), smooth zoom (R3), contiguous grouping (R4), scoped scroll navigation and selected-time centering now exist in the files recorded above. Their source attribution does not establish complete capture, timeline, gesture or period acceptance; task completion requires the corresponding integration and device checks.

Run `node scripts/verify-upstream.mjs` to verify locked source hashes, line counts, exact research excerpts and retained license bytes. `source-lock.json` records the selected source versions. Installed dependency notices remain in their package distributions; release packaging must include the root `LICENSE`, this file and both retained source licenses.

## Direct Runtime Packages

Read from the installed, locked package manifests on 2026-10-15:

| Package | Version | License |
| --- | --- | --- |
| Electron | 42.11.14 | MIT; Electron distribution also includes Chromium/Node third-party notices |
| React / React DOM | 18.3.1 | MIT |
| better-sqlite3 | 12.11.1 | MIT |
| Zod | 4.1.13 | MIT |
| diff | 8.0.4 | BSD-3-Clause |
| lucide-react | 0.468.0 | ISC |

These packages are consumed through their published APIs. Preserve their distributed license files when packaging; this table does not replace Electron's full third-party notices or the source licenses above.
