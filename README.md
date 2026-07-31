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

## When an icon does not look right

A website may publish several icons whose sharpness, padding, and borders vary by source. If an automatically retrieved icon is blurry, bordered, or otherwise unsuitable, open **Manage cache** from the top toolbar, find the domain, and select **Change icon**:

- Choose from the candidates discovered by the plugin; each card shows pixel dimensions, format, and file size.
- Upload a local image.
- Enter a directly accessible image URL.

A manually selected icon is pinned locally and is not replaced by normal refreshes, cache expiration, or **Clear all cache**. Select **Restore automatic retrieval** when you want the plugin to choose again.

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

Search for **Auto Favicon** in the SiYuan Marketplace and install it, or extract `package.zip` into `workspace/data/plugins/auto-favicon/`. Enable the plugin, open its settings to choose a network and display strategy, then use the Auto Favicon button in the top toolbar for common actions.

## Feedback

Users who cannot conveniently access GitHub can reply to the [Auto Favicon community post](https://ld246.com/article/1785052610863). GitHub users can also report problems through [GitHub Issues](https://github.com/Acetab/auto-favicon/issues).

When reporting a problem, please include the Auto Favicon and SiYuan versions, operating system, affected public URL, network strategy, favicon provider and fallback setting, whether Link Icon is enabled, and any relevant `[auto-favicon] Unable to cache` console error. Remove private URLs, note content, tokens, and local paths before posting.

## Credits and license

The idea of displaying icons before links and the original need for this plugin were inspired by [Link Icon](https://github.com/chenshinshi/link-icon). Auto Favicon was built through **Vibe Coding** and is licensed under the [MIT License](LICENSE).

## Recent updates

### 0.5.5

- Added a before-and-after preview that shows the effect of automatic website icons more clearly.
- Made it clearer how to change and pin a discovered, local, or URL-based icon from cache management.
- Show icon dimensions, format, and file size on candidate cards to help avoid blurry, bordered, or unsuitable variants.

### 0.5.4

- Fixed all favicon refreshes failing on the first run in a new workspace.
- Safely handle plugin settings and cache data that have not been created yet or contain an invalid value.
- Show the domain, failure stage, and specific reason when a manual refresh fails.

See [GitHub Releases](https://github.com/Acetab/auto-favicon/releases) for the complete version history.
