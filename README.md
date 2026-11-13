# Canvas Live Translate

Switch your Obsidian Canvas notes from Japanese to English for viewing, while keeping the originals unchanged.

- Toggle between Japanese editing and a read-only, scrollable English view.
- Keep the Canvas layout, cards, and connections while presenting your notes in English.
- Translate supported Notion web cards in place, with local caching and retry controls.

**Status:** Experimental desktop plugin, version **0.2.2**. The maintainer reports it working on **macOS**; exact macOS and Obsidian versions have not been recorded. Windows and Linux are unverified. This report does not establish compatibility with every Notion embed, theme, or Canvas plugin.

**Requires:** Obsidian **1.11.4+** and an OpenAI API key with access to the configured model. Translation sends note text and short context to OpenAI and may incur API charges. See [cost and privacy](#model-cost-and-privacy).

[日本語のインストール・操作ガイド](INSTALL-ja.md) · [Changelog](CHANGELOG.md)

## Install manually

1. Download this repository with **Code → Download ZIP**, then extract it.
2. Create `.obsidian/plugins/canvas-live-translate/` inside your vault. On macOS, use `Command + Shift + .` in Finder to show hidden folders.
3. Copy **only** `main.js`, `manifest.json`, and `styles.css` from the extracted repository into that folder. The repository includes a built `main.js`, so installation does not require Node.js.
4. Restart Obsidian and enable **Canvas Live Translate** in Settings → Community plugins.
5. In the plugin settings, select or create an OpenAI API key using Obsidian SecretStorage.
6. Open a Canvas and click **Canvas: JA** in the status bar to show English. Switch back to JA to edit.

If installing from a GitHub Release, use the same three files from that release. Preserve any existing `data.json` when upgrading.

## Using it

- Open a Canvas and click the **languages** ribbon icon or the **Canvas: JA** status-bar label. The command palette also has **Toggle Japanese / English in the active Canvas**.
- English mode displays a **read-only, scrollable presentation layer**. Click inside a card, select/copy text, and scroll without entering the actual Markdown editor. Typing, pasting and task-checkbox edits in translated cards are blocked.
- Toggle back to **JA** to edit your Japanese notes. The translation layer is removed; original text is not reconstructed from English and is not overwritten.
- Card positions, edges, zoom and source files are not changed by translation. Ctrl/Command/pinch zoom and Shift/horizontal pan remain available.
- Scroll or pan to another area: pending visible text is promoted in the queue. Previously translated text is cached.
- **Retry untranslated Canvas text** retries unfinished/failed parts without retranslating successful ones.
- **Show original Japanese (stop translation and unlock editing)** explicitly exits translated mode.
- **Show translation status** shows model, concurrency, unique text counts, last error and Notion compatibility counts. It does not include your API key or note contents.

Only the active Canvas receives a presentation layer. Changing tabs restores the previous Canvas; returning to a Canvas while translation is enabled uses the shared cache. API requests already sent may still finish after OFF; their stale results cannot re-create the presentation.

## Upgrade from v0.2.1 or earlier

1. Turn the plugin OFF in Obsidian Community plugins.
2. Quit Obsidian completely (`Cmd+Q` on Mac). This also clears any old cached preview DOM.
3. Unzip the install archive. Copy only `main.js`, `manifest.json`, and `styles.css` into the existing vault folder `.obsidian/plugins/canvas-live-translate/`, replacing those three plugin files.
4. **Keep `data.json` and the rest of your vault.** Do not replace/delete the whole existing plugin folder. Your settings and SecretStorage key reference remain.
5. Reopen Obsidian and enable the plugin. Confirm its version is **0.2.2**.
6. Optional: Settings → Canvas Live Translate → **Use fast preset**. This selects `gpt-6-luna`, reasoning disabled, three parallel requests. Existing custom model settings are otherwise retained.

Upgrading from v0.2.0/v0.2.1 retains the translation cache, model choice and other settings. Older v0.1.0 cache entries use a previous key format and are not reused.

## Notion web cards

With **Translate Notion web cards** enabled, the plugin uses an already-loaded Notion desktop webview in the Canvas. Supported hosts are `notion.so`, `notion.site`, and `notion.com`, including subdomains such as `app.notion.com`.

No import, Notion integration token, third-party synchronization service, or separate server is required. The visible/loaded document is read through the existing card. This does not log in, request additional Notion permissions, read cookies, or use private Notion APIs.

Notion's original editor DOM is not translated. A sanitized read-only snapshot is shown **inside the same web card**, with its own scrolling. The snapshot can include the page title, properties, images, mathematical rendering and loaded text. Scroll position is mirrored to the original view to allow lazy rendering; source-DOM changes refresh the snapshot. The normal Notion site controls are not a fully interactive translated website.

Important limitations:

- The card must expose the supported **Electron webview** API. If an Obsidian version/plugin renders an inaccessible iframe, the status reports **Notion unsupported**; the plugin does not bypass cross-origin security.
- A login/permission wall is not bypassed. Open/access the page normally first. `Notion loading` can also mean the expected page-content structure was not found.
- Expand Notion toggles/sections in JA before enabling English. Unloaded or collapsed content cannot be assumed to be included.
- Links retain their text/appearance but are disabled in the Notion English snapshot; return to JA to open them or use site controls.
- Images themselves and PDFs are not translated (no OCR).
- If original-view restoration fails, the plugin shows **restore error**, not a successful JA state. Run **Show original Japanese** again; if the webview is unresponsive, reload that card or restart Obsidian.

## Model, cost and privacy

The default is **GPT-6 Luna**, with `reasoning_effort: none`, using OpenAI's Chat Completions API and strict structured outputs. This was already the default model in v0.1.0; the speed improvements are principally fewer redundant tokens/requests, better scheduling and failure recovery, not a claim that a different model was selected.

Model documentation: https://developers.openai.com/api/docs/models/gpt-6-luna

Structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs

Translation sends Japanese text fragments plus short context to OpenAI. Do not enable it on confidential material unless that transfer is permitted. The official API request opts out of response storage (`store: false`); this is not a claim of zero provider retention. API usage can be billable under your OpenAI account; this plugin does not use the ChatGPT website subscription/session.

API keys stay in Obsidian SecretStorage and the host-side authorization header. They are never saved in `data.json` or passed into Notion. Settings and translations are cached locally through the plugin-data mechanism; consider whether your backup/sync includes that file.

## Remaining limitations and testing boundary

- **macOS operation is reported working by the maintainer.** Exact system versions and feature-by-feature coverage have not been recorded. Automated tests separately use simulated Canvas DOM, mocked Obsidian transport and minified production bundles; they do not certify all native Obsidian or Notion versions.
- Canvas's rendering/editing internals are not a stable public API. DOM selectors and capability-checked `startEditing` / `showPreview` hooks may need adjustments after Obsidian or another Canvas plugin changes.
- Sentences split into many bold/italic/link spans are translated as fragments to retain layout. Context helps, but English word order/spacing can be less natural than a full-document translation.
- Formulas, code, existing English and image text are intentionally excluded. Japanese within those protected regions is not a failed prose translation.
- The native reading clone does not reproduce arbitrary interactive plugin widgets. Embedded iframe/webview widgets inside a Markdown note are omitted from that clone; pure Notion web cards use the separate adapter.
- Native `requestUrl` does not offer physical cancellation or a timeout API. Already-sent requests retain their in-flight slot until they settle. No repeated timeout retry loop is used, to avoid runaway requests/billing; a stuck connection can delay later requests.
- No latency benchmark or equivalence to a particular ChatGPT mode is claimed. Model/API latency, text quantity, rate limits and network conditions still matter.

## Build and tests

Requires Node.js 22 or newer (the development build used Node.js 24).

```bash
npm ci
npm run check
```

The check typechecks all production sources, runs the regression suite, and builds `main.js`. Tests do not make billable API calls. Tests cover response IDs/partial recovery/refusals/errors; deduplication, concurrency and retries; native read-only scrolling; exact original restoration; Notion serialization, URL scoping and teardown ordering; and registered-command integration using the minified bundle.

## Data integrity

Translation code does not call `vault.modify()`, `vault.create()`, Canvas data setters or Canvas save methods. Translation changes are confined to presentation clones. Temporary input guards, scroll positions and visibility classes are restored on teardown. Normal settings/cache persistence uses `saveData()`.

## Reporting problems

Open a GitHub issue with your macOS/OS version, Obsidian version, plugin version, card type, reproduction steps, and the output of **Show translation status**. Mention other Canvas plugins in use. Remove private note text and never include API keys or `data.json`.

## License

[MIT](LICENSE). Maintained by Shu. See [release instructions](RELEASING.md) for packaging.
