# tianmu-hackthon-15 Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-10-15

## Active Technologies

- TypeScript 5.9.3; Swift 5 language mode; build Node.js 22.22.2 and npm 10.9.7 + Electron 42.11.14, React 18.3.1, electron-vite 5.0.0, Vite 7.3.7, electron-builder 26.15.3, better-sqlite3 12.11.1, Zod 4.1.13, diff 8.0.4 (001-event-driven-capture)

## Project Structure

```text
specs/001-event-driven-capture/   feature specification and design contracts
docs/                           product and technical overview
src/ native/ tests/             capture, extraction/model, day/month review, persistent report/delete
```

## Commands

Use `npm ci`, `npm run native:build`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, and `npm run package:mac`. See README.md and docs/DEVELOPMENT_HANDOFF.md for the foundation and ownership boundaries.

## Code Style

TypeScript 5.9.3; Swift 5 language mode; build Node.js 22.22.2 and npm 10.9.7: Follow standard conventions

## Recent Changes

- 001-event-driven-capture: Added TypeScript 5.9.3; Swift 5 language mode; build Node.js 22.22.2 and npm 10.9.7 + Electron 42.11.14, React 18.3.1, electron-vite 5.0.0, Vite 7.3.7, electron-builder 26.15.3, better-sqlite3 12.11.1, Zod 4.1.13, diff 8.0.4

<!-- MANUAL ADDITIONS START -->

- Updated scope: generic repeated actions/sequences and upstream semantic task recipes can become SOP candidates, not just reports. Explicitly confirmed browser recordings run locally through pinned OpenAdapt Flow; native-app execution is not yet exposed. Corporate coupon/strategy writes remain preview-only.

- This checkout implements Electron/SQLite/Swift capture, AX/OCR, model configuration/consent/queue, activity review, day/month timelines and persistent reports/deletion. A controlled Cocoa window has passed the real capture-to-database chain on one Mac. Ordinary desktop visibility, full semantic/hardware acceptance and SOP/Codex execution remain pending; report actual checks separately from full product acceptance.
- Use specs/001-event-driven-capture/spec.md and plan.md with data-model.md and contracts/ as the implementation baseline. The constitution is an unratified template; its check is N/A, not PASS.
- Delivery order: P0 labeled timeline, period summaries, day/month review and reports; P1 daily/weekly/ordinary document SOPs with Codex; P2 coupon/strategy discovery and preview only.
- Use Electron/React/TypeScript with small Swift helpers; no Rust or Pi runtime. The user explicitly permits adapting MemoryLane GPL code and publishing this project as open source (2026-10-22). Distribute One Room under GPL-3.0-or-later, preserve the root LICENSE, and retain upstream source, copyright, licenses and changes in THIRD_PARTY_NOTICES.md; do not reintroduce the old architecture-only restriction.
- Capture authorized visible-window facts/screenshots before extraction or models. AX visible body first, local OCR fallback. Excluded contexts cannot fall back through another extractor. Never record keystroke contents or clipboard text.
- Screenshots expire individually after 30 days; text, periods, time allocation and reports remain. Manual deletion invalidates sources and scrubs derived copies; do not confuse it with screenshot expiry.
- Background text analysis is separately authorized, defaults off, and persists until revoked. Check scope/generation before dispatch and commit. No automatic screenshot upload.
- Logical instances can resume across A-B-A periods; count distinct instances, not screenshots or returns. Workers only produce findings through a bounded host and cannot write documents or invoke business operations.
- Codex requires a supported locally installed/authenticated CLI and a synthetic capability gate. Review frozen input before sending, then review the exact diff before application writes. Claude is visible and disabled. The retained corporate Docs executor does not satisfy this contract; production run/verify routes remain blocked.
- Applying/verifying cannot be canceled mid-transaction. Recover from persisted operation hashes, preserve outside bytes, and never overwrite conflicts. Local hash/rename does not provide cross-process CAS; require exclusive editing or export a patch. Uncertain cloud writes require read-only verification without automatic replay; cloud OT baseVersion is not strong CAS. Coupon/strategy execution is preview only.
- Local Electron SQLite ABI, helper handshake and controlled-window capture/AX/OCR are verified. Transparent fullscreen overlay tools currently cause strict visibility rejection for ordinary windows. Developer ID/notarization, second-Mac installation, ordinary-window/TCC acceptance, two-Mac three-finger gestures and Codex/document flows remain pending gates. Synthetic gestures do not prove three-finger support.

<!-- MANUAL ADDITIONS END -->
