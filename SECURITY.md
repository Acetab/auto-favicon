# Security

Do not post logs containing private notes, internal domains, access tokens, or other sensitive information in public issues.

By default, automatic retrieval accesses only domain roots, official platform icon assets, and the selected favicon services. Third-party services receive domains only. A specific page path is sent to its original website only after the user enables specific-page discovery or explicitly loads page-specific candidates; query parameters, fragments, cookies, authorization headers, and referrers are omitted. Localhost and private-network addresses are not resolved automatically or sent to external services.

For vulnerabilities that could expose note content, bypass private-network restrictions, or write arbitrary files, use the repository's private security-reporting feature.

---

# 安全说明

请不要在公开 Issue 中提交包含私人笔记、内网域名、访问令牌或其他敏感信息的日志。

默认自动获取只访问域名根页面、平台官方图标资源和所选 favicon 服务，第三方服务只收到域名。只有用户开启具体页面探测，或主动加载页面专属候选时，插件才会把去掉参数和锚点的路径发送给原网站；请求不携带 Cookie、Authorization 或 Referer。内网和本机地址默认不会被自动解析或发送给外部服务。

如果发现可能泄露笔记数据、绕过内网限制或造成任意文件写入的安全问题，请通过 GitHub 仓库的私密安全报告功能联系维护者。
