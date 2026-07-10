[English](README.md) | [简体中文](README.zh-CN.md)

# Auto Favicon

I originally used [chenshinshi/link-icon](https://github.com/chenshinshi/link-icon) and found its curated website icons and block-reference icons very useful. As the number of websites in my notes grew, a static icon library could no longer cover every domain. Inspired by its approach of displaying icons before links, I built this plugin through **Vibe Coding** to retrieve website icons automatically.

This project is not intended to replace `link-icon`. They work well together: `link-icon` provides curated icons, custom icons, and block-reference icons, while Auto Favicon fills in websites that are not covered by its library.

The plugin is still evolving. When reporting a problem, please include the URL, your SiYuan version, network strategy, and whether another link-style plugin is enabled.

![Plugin preview](preview.png)

## Features

- Detect HTTP/HTTPS links in documents and display a website icon before each link.
- Discover `rel=icon`, Apple Touch Icon, Web App Manifest icons, and `/favicon.ico`.
- Support FaviconKit, favicon.im, Icon Horse, automatic multi-source resolution, and custom services.
- Provide Standard Network, Proxy Network, and Direct Website Only strategies.
- Cache downloaded icons locally in the SiYuan workspace.
- Generate a colorful domain monogram locally when no real favicon is available.
- Configure icon size, cache lifetime, and full cache refresh.
- Avoid inline styles in editable document content.

## Choosing a network strategy

| Strategy | Sources | Recommended for |
|---|---|---|
| Standard Network | The linked website and the selected third-party service; never Google or DuckDuckGo | Daily use and networks where Google/DDG are unavailable |
| Proxy Network / Maximum Coverage | Standard sources plus Google and DuckDuckGo | A proxy that is available to SiYuan and maximum favicon coverage |
| Direct Website Only | The target page, its manifest, and `/favicon.ico` only | Users who do not want domains sent to third-party favicon services |

All strategies try the website itself first. Even if a foreign website cannot be opened directly, Standard Network may still show its real icon when the selected service has cached it. Otherwise, the plugin can use a local monogram. Direct Website Only strictly depends on whether SiYuan can reach the target website.

## Third-party favicon services

- **Automatic (recommended):** tries FaviconKit, then favicon.im.
- **FaviconKit:** currently provides good coverage for common domestic and international websites in testing.
- **favicon.im:** resolves several favicon sources, but may time out on some networks.
- **Icon Horse:** returns real icons for common websites and may return a letter placeholder for unknown domains.
- **Custom service:** use `{domain}` as a placeholder, for example `https://example.com/favicon/{domain}`.

## Working with link-icon

The two plugins have different roles:

- `link-icon` supplies curated static icons, user-defined icons, and SiYuan block-reference icons.
- Auto Favicon discovers, downloads, and caches favicons for domains that are not covered.

For the best combined experience, keep **Override link-icon website icons** disabled:

1. Curated or user-defined `link-icon` icons take priority.
2. Auto Favicon fills in uncovered domains automatically.
3. SiYuan document and block-reference icons remain handled by `link-icon`.

Enable the override only if you prefer the favicon currently published by each website. This project does not duplicate link-icon's static icon library or block-reference feature.

## Usage notes

The plugin can decorate only elements that SiYuan has recognized as links. Plain-text URLs must first become hyperlinks—for example, paste a browser URL, press Space or Enter after typing, use Markdown link syntax, or apply SiYuan's link command to selected text.

The first icon for a domain may take a moment. After changing a strategy or service, use **Refresh all icons** in plugin settings.

## Privacy

When a domain is first encountered, the plugin may ask the SiYuan kernel to access the public page and discover its icon. Standard Network may send the domain name to the selected favicon service. Proxy Network may additionally send it to Google and DuckDuckGo. Note content, anchor text, and full URL paths are not sent to favicon services.

Localhost, local-network, and private addresses are not resolved automatically or sent to external services. Select Direct Website Only to minimize third-party requests.

## Inspiration and acknowledgements

- The original need, the visual approach of placing icons before links, and parts of the SiYuan link-structure adaptation were inspired by [chenshinshi/link-icon](https://github.com/chenshinshi/link-icon). Thanks to its author and contributors.
- This package does not redistribute link-icon's static icon library or copy its block-reference implementation. Multi-source resolution, cache validation, network strategies, and settings are implemented independently in this project.
- If you prefer link-icon's curated or manually configured icons, disable **Override link-icon website icons** and let the plugins complement each other.

## License

This project is released under the [MIT License](LICENSE). You may use, modify, and redistribute it while retaining the copyright and license notice.

## Changelog

### 0.5.0

- Renamed the strategies to Standard Network, Proxy Network / Maximum Coverage, and Direct Website Only.
- Removed Google and DuckDuckGo from Standard Network.
- Added Automatic, FaviconKit, favicon.im, Icon Horse, and custom favicon services.
- Automatic mode tries FaviconKit before favicon.im.
- Renamed the icon-priority setting to Override link-icon website icons and disabled it by default for new installations.
- Added English documentation and a bilingual settings interface that follows the SiYuan language.

### 0.4.0

- Added locally generated colorful monograms for websites without available icons.
- Added icon size, cache lifetime, source priority, and cache-management settings.
- Added cache statistics, cache clearing, and full icon refresh.
- Added a cooldown after failed requests to avoid repeated network access while editing.

### 0.3.0

- Added layered resolution through page declarations, manifests, root paths, and multiple favicon services using the SiYuan network proxy.
- Added cache validation and automatic cleanup of old or damaged icon files.
- Display icons only after download, storage, reload, and image decoding all succeed.

### 0.2.0

- Stopped writing inline CSS variables into editable links.
- Switched to a plugin-level stylesheet to prevent `{: style="..."}` text from appearing after edits.

### 0.1.0

- Initial release.
- Detected external-link domains and fetched icons through favicon.im for local caching.
