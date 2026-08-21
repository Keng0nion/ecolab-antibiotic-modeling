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

`audit:release` 检查部署配置、版本、文件内容、大小预算、禁止路径、Markdown 链接和 SHA-256 manifest。`check:reproducible` 在两个临时目录完成干净构建并比较每个文件的内容哈希。Safari 冒烟测试需要手动启用远程自动化。

## English

`dist/web/` is a static site with no application server, database, or runtime secret. Publish the directory unchanged, preserve `_headers` or configure equivalent response headers, and do not add `data/raw/` or XLSX workbooks. Hash routing requires no SPA fallback, and relative asset URLs support root or subdirectory deployment.

The CSP permits same-origin ES modules, same-origin module Workers, same-origin data fetches, and `blob:` downloads. It contains no `unsafe-inline`; four controlled inline CSS custom-property values are authorized by exact `unsafe-hashes`. A host that ignores `_headers` must reproduce the policy in its own configuration before CSP deployment can be claimed.
