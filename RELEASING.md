# Releasing canvas-live-translate

Use this directory as the root of its own GitHub repository named `canvas-live-translate`. Keep `manifest.json` at the repository root.

1. Run `npm ci` followed by `npm run check`.
2. Confirm `manifest.json` and `versions.json` agree on the version and minimum Obsidian version. For Canvas Live Translate, also keep `package.json` and `package-lock.json` versions in sync.
3. Update the changelog and record any tested OS/Obsidian versions. Do not infer a tested version from `minAppVersion`.
4. Review `git status` before committing. Exclude `data.json`, `.env` files, credentials, personal vault files, and `node_modules`.
5. Commit and push the reviewed files to this plugin's GitHub repository.
6. Create a GitHub Release tagged **`0.2.2`** for the current version (no `v` prefix). For later releases, use the exact version from `manifest.json`.
7. Attach `main.js`, `manifest.json`, and `styles.css` as individual release assets. GitHub's automatic source archives do not replace these assets for Obsidian installation.
8. Install the attached files in a test vault and verify the plugin loads and its main interactions work.

Publishing a GitHub repository/release and listing it in Obsidian's community directory are separate steps. Follow the [official submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) when ready for a directory submission.
