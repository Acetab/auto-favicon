# Contributing

Issues and improvement suggestions are welcome. When reporting a problem, please include:

- SiYuan version and operating system;
- plugin version, network strategy, favicon provider, and fallback behavior;
- the complete public URL whose icon cannot be resolved;
- whether link-icon or another link-style plugin is enabled;
- the complete `[auto-favicon] Unable to cache` console error with private
  information removed.

Before submitting code, run:

```powershell
npm ci
npm run check
npm run build
```

Do not commit `node_modules`, local caches, SiYuan workspace data, or API keys.

Maintainer releases are automated by `.github/workflows/release.yml`. Keep the
versions in `package.json`, `package-lock.json`, and `plugin.json` aligned, push
the source commit, and then push a `vX.Y.Z` tag. GitHub Actions will build and
attach `package.zip`; do not manually create the same Release first.

---

# 参与贡献

欢迎提交问题和改进建议。报告问题时，请尽量附上：

- 思源版本和操作系统；
- 插件版本、网络策略、图标服务和失败后的兜底方式；
- 无法取得图标的完整公开链接；
- 是否启用了 link-icon 或其他链接样式插件；
- 完整的 `[auto-favicon] Unable to cache` 控制台错误，注意移除隐私数据。

提交代码前请运行：

```powershell
npm ci
npm run check
npm run build
```

请不要提交 `node_modules`、本地缓存、思源工作空间数据或任何 API 密钥。

维护者发布版本时由 `.github/workflows/release.yml` 自动处理。请先确保
`package.json`、`package-lock.json` 和 `plugin.json` 中的版本一致，推送源码提交，
再推送 `vX.Y.Z` 标签。GitHub Actions 会构建并附加 `package.zip`，不要提前手动创建
同名 Release。
