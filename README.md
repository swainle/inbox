# e-com.cc 收件箱

## 说明

`frontend/` 是 Vue 3 页面。`backend/` 是 Cloudflare Email Worker。后端使用 D1 保存邮件索引，使用 R2 保存附件和大正文。前后端在同一仓库中独立运行。

## 本地部署

条件：安装 Node.js 22 或更新版本。

如果本地服务已启动，请先停止它们，再运行 `npm ci`。Windows 会锁定正在使用的原生模块文件。

1. 进入 `backend/`，运行 `npm ci`。
2. 首次启动时，运行 `npx wrangler d1 execute inbox --local --file=./schema.sql`。
3. 运行 `npm run dev`。
4. 打开另一终端，进入 `frontend/`。
5. 运行 `npm ci`。
6. 运行 `npm run dev`。

前端会将 `/api/` 请求转发到本地后端。

## 生产部署

部署前，创建 Cloudflare D1 数据库 `inbox` 和 R2 存储桶 `inbox`。核对 [`backend/wrangler.jsonc`](backend/wrangler.jsonc) 中的数据库 ID、域名路由和邮件地址规则。确认域名 DNS 已启用 Cloudflare 代理，并核对邮件路由规则。

新数据库：

1. 进入 `backend/`，运行 `npm ci`。
2. 运行 `npx wrangler d1 execute inbox --remote --file=./schema.sql`。
3. 运行 `npm run deploy`。

已有数据库：先备份 D1。按数据库现状和文件名顺序执行 `backend/20261010235500_add_read_status.sql`、`backend/20261010235501_add_accounts.sql` 和 `backend/20261010235502_add_mailbox_deletion.sql`；已执行过的迁移不要重复执行。不要对已有数据库运行 `schema.sql`。完成迁移后，在 `backend/` 运行 `npm run deploy`。

前端部署：

1. 进入 `frontend/`，运行 `npm ci`。
2. 首次使用 Wrangler 时，运行 `npx wrangler login`。
3. 如果还没有 Pages 项目，运行 `npx wrangler pages project create`。
4. 运行 `npm run deploy`，按提示选择 Pages 项目。
5. 在 Pages 项目中绑定 `e-com.cc`。

上传目录是 `frontend/dist/`。其中的 `mail/` 子目录对应网站的 `/mail/` 路径。生产环境的 `e-com.cc/api/*` 路由仍指向后端 Worker。前端尚未部署。

## 页面地址

| 环境 | 地址 |
| --- | --- |
| 本地 | `http://localhost:5173/mail/` |
| 生产 | `https://e-com.cc/mail/` |
| 指定邮箱 | `https://e-com.cc/mail/?address=abc12` |

“收件箱”链接跳转到同一页面的收件箱区域。指定邮箱地址只显示 `abc12@e-com.cc` 的邮件。长效邮箱仅所属账号登录后可读取；临时邮箱仍可凭地址公开读取。

## 接口地址

| 环境 | 地址 |
| --- | --- |
| 本地直连 | `http://localhost:8787/api/` |
| 本地页面调用 | `http://localhost:5173/api/` |
| 生产 | `https://e-com.cc/api/` |

接口请求示例见 [`backend/api.http`](backend/api.http)。
