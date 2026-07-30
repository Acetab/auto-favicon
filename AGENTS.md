# Auto Favicon project instructions

## Purpose

Auto Favicon is a focused SiYuan plugin that automatically shows website favicons
before external links. Keep the scope narrow and preserve coexistence with Link Icon.

## Commands

```powershell
npm ci
npm run check
npm run build
```

`npm run check` must pass TypeScript validation. `npm run build` must produce the
complete marketplace payload in `dist/`.

## Stack and structure

- TypeScript, Vite, npm, and the SiYuan plugin API.
- `src/index.ts`: plugin lifecycle, settings, cache management, and UI.
- `src/icon-resolver.ts`: favicon discovery and resolution.
- `src/style.css`: plugin UI styles.
- `i18n/`: English and Chinese strings; keep both key sets aligned.
- `scripts/render-assets.mjs`: generated image assets.
- `.github/workflows/release.yml`: tagged-release build and publication.

## Conventions

- Do not write `style` or `data-*` attributes to editable SiYuan document nodes.
  Use runtime CSS injected into `document.head`.
- Preserve Smart Fill and Auto Favicon Priority behavior with Link Icon.
- Keep user-pinned icons safe from ordinary refresh and cache cleanup.
- Do not add static icon libraries or unrelated diagnostic features.
- Avoid unrelated refactors, formatting, and line-ending changes.
- Do not discard uncommitted user work or publish without explicit approval.

## Release

- Keep versions aligned in `package.json`, `package-lock.json`, and `plugin.json`.
- Commit and push the intended source state before tagging.
- Push a `vX.Y.Z` tag; GitHub Actions validates, builds `package.zip`, and creates
  the GitHub Release automatically.
- Do not manually create the same Release or upload a second package beforehand.

## Current status

- As of 2026-07-30, v0.5.3 is the current release, has passed real SiYuan
  validation, and is listed in the SiYuan Bazaar.
- The release package uses forward-slash ZIP entry paths.
- A community report of a refresh ending with 0 successes and 2 failures is
  pending evidence. Before changing code, collect the SiYuan/plugin versions,
  resolver/provider/fallback settings, and the complete
  `[auto-favicon] Unable to cache` console error.
- Before future delivery, rerun both validation commands above.
