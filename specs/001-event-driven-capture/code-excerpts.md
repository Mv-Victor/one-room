# Screenpipe MIT 研究摘录

来源：v2.2.243，提交 `1b3e4186ec5a624b95a581c7187c1d48284bea9a`。完整许可见 [screenpipe-MIT.txt](licenses/screenpipe-MIT.txt)。本文件是带上下文的局部原文摘录，不是已移植、可独立运行的 One Room 模块。

## SP-1

[crates/screenpipe-engine/src/event_driven_capture.rs:L94–L107](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-engine/src/event_driven_capture.rs#L94)

事件触发和补采的参数依据。该片段从 Default 实现内部截取，未包含整个 impl 闭合；One Room 参数须实测，不采集剪贴板正文。

```rust
impl Default for EventDrivenCaptureConfig {
    fn default() -> Self {
        Self {
            min_capture_interval_ms: 200,
            idle_capture_interval_ms: 30_000, // 30 seconds
            typing_pause_delay_ms: 500,
            scroll_stop_delay_ms: 300,
            jpeg_quality: 80,
            capture_on_click: true,
            capture_on_clipboard: true,
            visual_check_interval_ms: 3_000, // check every 3 seconds
            visual_change_threshold: 0.05,   // ~5% difference triggers capture
        }
    }
```

## SP-2

[crates/screenpipe-engine/src/paired_capture.rs:L125–L140](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-engine/src/paired_capture.rs#L125)

AX 非空不代表正文完整；保留 OCR 补充及 hybrid 的原因。该片段止于分支开始，依赖未包含的类型和函数，需要自行适配。

```rust
    let has_accessibility_text = !app_prefers_ocr
        && tree_snapshot
            .map(|s| !s.text_content.is_empty())
            .unwrap_or(false);

    // Check if accessibility text is "thin" — the tree returned SOME text
    // (toolbar, sidebar, browser chrome) but likely missed the main content.
    // This happens with canvas-rendered apps (Google Docs, Figma, etc.)
    // where the document body is invisible to the accessibility tree.
    let a11y_is_thin = has_accessibility_text
        && tree_snapshot
            .map(|s| a11y_content_is_thin(s, ctx.window_name, ctx.browser_url, ctx.app_name))
            .unwrap_or(false);

    // Run OCR when: no a11y text, app prefers OCR, OR a11y text is thin (hybrid)
    let (ocr_text, ocr_text_json) = if !has_accessibility_text || a11y_is_thin {
```

## SP-3

[apps/screenpipe-app-tauri/components/rewind/hooks/use-frame-loading.ts:L314–L328](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/apps/screenpipe-app-tauri/components/rewind/hooks/use-frame-loading.ts#L314)

预加载及取消过期回调的思路。该片段止于回调内部，依赖 Tauri 及外部状态；进入 gap 还须主动清图，不能照搬旧图保留行为。

```typescript
	// Snapshot frames: load directly via Tauri asset protocol (no HTTP/DB needed)
	useEffect(() => {
		if (!isSnapshotFrame || snapshotFailed || !debouncedFrame?.filePath) return;
		let cancelled = false;
		frameLoadStartTimeRef.current = performance.now();

		getVideoUrl(debouncedFrame.filePath).then((url) => {
			if (cancelled || !url) return;
			// Preload before displaying to avoid flicker
			const img = new Image();
			img.onload = () => {
				if (cancelled) return;
				setSnapshotAssetUrl(url);
				setIsLoading(false);
				setHasError(false);
```
