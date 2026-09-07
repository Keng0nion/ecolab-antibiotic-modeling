# Deployment / 静态部署

## 中文

Ecolab Web 产物是 `dist/web/` 中的静态站点，不需要应用服务器、数据库或运行时密钥。

```bash
npm run build:clean
npm run build:core
npm run build:web
npm run audit:release
npm run preview
```

`npm run build` 会先运行语法、版本、数据和全套自动化测试，再清理并生成两个正式产物。分步命令适合部署排查，但正式发布记录应优先包含完整构建结果。

### GitHub Pages

当前公开网站：<https://keng0nion.github.io/ecolab-antibiotic-modeling/>

`.github/workflows/deploy-pages.yml` 在每次推送到 `main` 时运行 `npm run build:public`，然后通过 GitHub 官方 Pages Actions 发布 `dist/web/`。公开构建会执行语法与版本检查、发布测试、可复现性检查、正式 Core/Web 构建和发布审计；它不会假装读取被 `.gitignore` 排除的 `data/raw/` 来源文件。本地完整 `npm run build` 仍会额外运行原始数据审计和全量测试。也可以在 GitHub Actions 页面使用 `workflow_dispatch` 手动重新部署。该方案不需要服务器、数据库或运行时密钥。

GitHub Pages 不处理仓库中的 `_headers` 文件，因此 Pages 部署本身不会应用其中声明的 CSP、Referrer Policy、Permissions Policy 或缓存响应头。应用仍然可以运行，但不能将当前 Pages 地址表述为“已部署 `_headers` 安全策略”。若需要这些响应头，应使用 Cloudflare Pages、Netlify 或其他支持自定义响应头的静态托管平台。

### 托管要求

- 按文件原样发布 `dist/web/`，保留相对目录结构。
- 服务 `index.html`、`.js`、`.css`、`.json`、`.csv`、`.md` 和 schema 文件。
- 不要把 `data/raw/` 或本地 XLSX 工作簿添加到站点。
- 保留构建复制出的 `_headers`，或把等效响应头配置到托管平台。
- 应用使用 hash 路由，因此不需要 SPA fallback 重写。
- 应用以相对 URL 加载资源，可部署在域名根目录或子目录。

### CSP

部署配置允许：

- `script-src 'self'`：同源 ES modules；
- `worker-src 'self'`：同源 module Worker；
- `connect-src 'self'`：同源注册表和数据读取；
- `navigate-to ... blob:`：本地生成文件下载；
- `style-src 'self'` 与精确 `style-src-attr 'unsafe-hashes'`：外部 CSS 及四个受控颜色自定义属性。

它不包含 `unsafe-inline`。若托管平台忽略 `_headers`，必须在平台配置中复制等效头；否则不能声称 CSP 已部署。

### 验证

```bash
npm run audit:release
npm run check:reproducible
npm run smoke:safari
```

`audit:release` 检查部署配置、版本、文件内容、大小预算、禁止路径、Markdown 链接和 SHA-256 manifest。6.0.0 还严格检查实际生成示例的研究包、来源/版本/预算关联，并显式复算比较科学投影与完整分析 manifest，不要求某个模型获胜或误差改善。`check:reproducible` 在两个临时目录完成干净构建并比较每个文件的内容哈希。Safari 冒烟测试需要手动启用远程自动化。

浏览器生成的研究包不是站点静态资产，可能大于静态最大单文件预算；导入另外受 32 MiB 安全限额约束。包内数据与算法输入可自包含，但回放仍需要精确内置软件，不联网安装依赖。6.0.0 在完成本地验证后，于 2026-09-07 获用户授权提交并上传现有 GitHub 仓库；推送到 `main` 会触发上述部署。具体线上结论以 [GitHub Actions](https://github.com/Keng0nion/ecolab-antibiotic-modeling/actions/workflows/deploy-pages.yml) 为准，本地验证记录见 [发布检查表](./release-checklist.md)，变更内容见 [6.0.0 更新说明](./release-notes-6.0.0.md)。

## English

Live site: <https://keng0nion.github.io/ecolab-antibiotic-modeling/>

`.github/workflows/deploy-pages.yml` runs `npm run build:public` on every push to `main` and publishes `dist/web/` with the official GitHub Pages Actions. The public build performs syntax and version checks, release tests, reproducibility checks, formal Core/Web builds, and the release audit; it does not pretend to read `data/raw/` provenance inputs excluded by `.gitignore`. The local full `npm run build` additionally performs the raw-data audit and complete test suite. The workflow can also be run manually through `workflow_dispatch`. No server, database, or runtime secret is required.

GitHub Pages does not interpret the repository's `_headers` file, so the Pages deployment does not apply its CSP, referrer, permissions, or caching response headers. The application remains functional, but the Pages URL must not be described as having those headers deployed. Use Cloudflare Pages, Netlify, or another host with custom-response-header support when those controls are required.

`dist/web/` is a static site with no application server, database, or runtime secret. Publish the directory unchanged, preserve `_headers` or configure equivalent response headers, and do not add `data/raw/` or XLSX workbooks. Hash routing requires no SPA fallback, and relative asset URLs support root or subdirectory deployment.

The CSP permits same-origin ES modules, same-origin module Workers, same-origin data fetches, and `blob:` downloads. It contains no `unsafe-inline`; four controlled inline CSS custom-property values are authorized by exact `unsafe-hashes`. A host that ignores `_headers` must reproduce the policy in its own configuration before CSP deployment can be claimed.
