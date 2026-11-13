# Changelog

These entries describe changes and validation performed at the time of each build. See the README for current compatibility reports.

## What changed in v0.2.2

- **Stable scrolling during lazy loading:** keep the same scroll container and unchanged translated text nodes while updating source content. Appended Markdown no longer replaces the whole English preview with a temporarily shorter Japanese clone, which could clamp the scroll position upwards.
- **Keep the reading paragraph in place:** apply ready translations together per animation frame and preserve visible paragraph offsets when content above them changes height, including Canvas zoom. Native lazy rendering follows the matching source paragraph when available.
- **Native wheel/trackpad scrolling:** let the browser handle vertical scrolling and momentum inside the overlay; prevent the same gesture from panning Canvas. The plugin no longer sets scrollTop on every wheel event in a translated card.
- Source edits still invalidate only their changed text; stale queued translations are rejected after edits/OFF. Equivalent native redraws retain current English and focus.

Translation remains incremental: newly loaded Markdown is translated as it appears, so the progress total can still grow while scrolling. No full-document prefetch was added.

Validation includes a deterministic model of bounded scrollTop and paragraph geometry; it reproduces the former upward-clamping failure and checks repeated loading through the bottom of a long note. This is not an actual browser/Obsidian performance benchmark. Chromium could not launch in the build environment, and macOS Obsidian needs user-side confirmation.

## What changed in v0.2.1

- **JA restoration for inactive cards:** force an available native Markdown preview to redraw from its original source, without opening the card or entering editing mode. Known translated text nodes are restored before their display layer is released, including renderer-retained descendants.
- **Cached-card cleanup:** clean detached Canvas node DOM and remove marked translation layers that the host reinserts later while in JA. Translation layers are also hidden by CSS unless English mode is active, so a stale clone cannot flash English before cleanup. Observers are released when their Canvas tab closes or English resumes.
- **Original padding:** carry the native container and preview padding into the translated clone, including theme/direct-child CSS rules and intentional zero padding.
- **No overlay tooltip:** remove the `Translated read-only view. Switch to Japanese to edit.` hover popup.

The source files, API model, translation cache format, Notion adapter and existing English scrolling behavior are unchanged by this patch. Validation uses simulated Canvas DOM and mocked transport; actual macOS Obsidian still needs user-side confirmation.

## What changed in v0.2.0

- Replaced direct edits to native preview text with **disposable cloned reading layers**, addressing English remaining after switching back to JA, detached/recycled cards and delayed API responses.
- Added scoped, reversible editing guards and card scrolling. English no longer intentionally disappears on a click into a text card.
- Replaced positional translation arrays with **explicit required IDs**, so a missing item cannot shift translations onto the wrong text.
- Valid partial responses are retained. Failed segments retry in progressively smaller batches, up to three attempts; ordinary failures do not stop all other cards.
- Authentication, billing and unsupported-model/configuration failures pause the queue with a specific error. Rate limits use bounded backoff.
- Defaults are now three concurrent requests, up to 24 parts / 6,500 source-plus-context characters per batch. Shared capacity also counts requests still running after a rapid OFF/ON.
- Added in-flight deduplication, context deduplication, parallel cache-key generation and live viewport priority updates.
- Added supported **Notion Add web page card** translation.
