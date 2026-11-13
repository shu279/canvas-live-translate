# Canvas Live Translate

Switch your Obsidian Canvas notes from Japanese to English for viewing, while keeping the originals unchanged.

**Status:** Experimental desktop plugin, version **0.2.3**.

**Requires:** Obsidian **1.11.4+** and an OpenAI API key with access to the configured model. Translation sends note text and short context to OpenAI and may incur API charges.

[Changelog](CHANGELOG.md)

## Install manually

1. Download the ZIP via **Code → Download ZIP** and extract it.
2. Rename the extracted folder to `canvas-live-translate` and move it into your vault's `.obsidian/plugins/` folder.
3. Restart Obsidian and enable **Canvas Live Translate** under **Settings → Community plugins**.
4. Select or create an OpenAI API key in the plugin settings, then click **Canvas: JA** to show English.

On Mac, press `Command + Shift + .` in Finder to show hidden folders. Keep your existing `data.json` when updating.

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

Translation sends Japanese text fragments plus short context to OpenAI. Do not enable it on confidential material unless that transfer is permitted. The official API request opts out of response storage (`store: false`); this is not a claim of zero provider retention. API usage can be billable under your OpenAI account; this plugin does not use the ChatGPT website subscription/session.

API keys stay in Obsidian SecretStorage and the host-side authorization header. They are never saved in `data.json` or passed into Notion. Settings and translations are cached locally through the plugin-data mechanism; consider whether your backup/sync includes that file.

## License

[MIT](LICENSE). Maintained by Shu. See [release instructions](RELEASING.md) for packaging.
