[English](README.md) | [简体中文](README.zh-CN.md)

# Auto Favicon

Auto Favicon automatically retrieves, displays, and locally caches website icons for HTTP/HTTPS links in SiYuan. When no usable favicon is available, it can generate a colorful domain monogram locally.

![Auto Favicon in SiYuan](screenshot.png)

## Features

- Discover icons from the target page, `/favicon.ico`, web manifests, and optional favicon services.
- Choose Standard Network, Proxy Network, or Direct Website Only.
- Cache verified icons in the SiYuan workspace and reuse them without external requests.
- Customize fallback monogram colors, letters, and shapes globally or per domain.
- Upload a custom icon, use an image URL, or choose from discovered candidates for a domain, with optional reuse across its subdomains.
- Work alongside **Link Icon** while preserving its curated and custom icons.
- Use the top-bar menu to change the display strategy, refresh the current document, manage cache, or open settings.

## Cache behavior

Opening a document scans its web links, but a fresh cached icon is loaded locally and is not downloaded again. New, expired, missing, damaged, or manually refreshed entries are retrieved using the selected network strategy.

- Default lifetime: 30 days.
- Enter `0` to keep icons until they are manually cleared.
- Generated monograms follow the same lifetime.
- Failed domains are paused for 10 minutes during the current plugin session.
- A failed manual refresh keeps the previous working icon.
- Manually selected icons are pinned locally until automatic retrieval is restored; normal cache clearing and expiration do not remove them.
- Icon files: `workspace/data/public/auto-favicon/`.
- Cache index: `favicon-cache.json`, managed through SiYuan plugin storage; refresh targets retain only the scheme, host, and port.

Cache management supports refreshing the current document, refreshing every automatically cached domain, searching cached domains, and refreshing or deleting a single domain.

## Working with Link Icon

[Link Icon](https://github.com/chenshinshi/link-icon) is the marketplace name of the project whose repository name is `link-icon`. The recommended **Smart Fill** mode uses this priority:

1. Link Icon curated or user-defined icons.
2. A real favicon retrieved by Auto Favicon.
3. A local colorful monogram.
4. Link Icon's generic web placeholder.

Auto Favicon does not redistribute Link Icon's static icon library or copy its block-reference implementation. SiYuan document and block-reference icons remain handled by Link Icon.

Pinned custom icons follow the same display strategy: Smart Fill still yields to a meaningful Link Icon graphic, while Auto Favicon Priority displays the pinned icon first.

## Network and privacy

- **Standard Network:** Target website plus the selected favicon service; no Google or DuckDuckGo requests.
- **Proxy Network:** Adds Google and DuckDuckGo for maximum coverage.
- **Direct Website Only:** Contacts only the linked website, then uses a local fallback if needed.

Localhost, `.local`, loopback, link-local, and private IP addresses are not sent to favicon services. Only the website domain is sent to third-party icon services—never note content, anchor text, or a complete page path.

## Install and use

Install from the SiYuan Marketplace when available, or extract `package.zip` into `workspace/data/plugins/auto-favicon/`. Enable the plugin, open its settings to choose a network and display strategy, then use the Auto Favicon button in the top toolbar for common actions.

## Credits and license

The idea of displaying icons before links and the original need for this plugin were inspired by [Link Icon](https://github.com/chenshinshi/link-icon). Auto Favicon was built through **Vibe Coding** and is licensed under the [MIT License](LICENSE).

### 0.5.1

- Added Smart Fill compatibility with Link Icon.
- Added customizable local monograms and per-domain overrides.
- Added a top-bar quick menu and detailed cache management.
- Added per-domain custom uploads, image URLs, and selectable discovered icon candidates.
- Clarified cache behavior, storage location, and user-facing descriptions.

See [GitHub Releases](https://github.com/Acetab/auto-favicon/releases) for the complete version history.
