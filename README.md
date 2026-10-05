# e-com.cc 公开收件箱

任意 `名字@e-com.cc` 收到的邮件公开展示在 `https://mail.e-com.cc/inbox/名字`。每个名字独立编号；`/inbox/名字/序号` 查看邮件，`/inbox/名字/latest` 查看最新一封。`/rand` 直接返回随机邮箱地址。所有页面和附件无需登录。**不要用这些地址接收验证码、密码重置邮件或私人信息。**

## 运行流程

1. Cloudflare Email Routing 的 `*@e-com.cc` Catch-all 将邮件交给本 Worker 的 `email()` 处理器。
2. Worker 解析 MIME 邮件，将收件人名字转成小写，在 D1 原子分配下一个序号并创建不可见的 `pending` 记录。
3. 附件写入私有 R2。正文小于 1 MiB 时存 D1；更大的正文存 R2。D1 写好索引后，邮件变为 `ready`，网页才会显示它。
4. `fetch()` 处理公开列表、纯文字详情和附件下载。任何人打开详情页后，该邮件会全局标记为已读。
5. 保存失败时邮件不会出现在列表；序号不会复用。处理器抛出错误，需查看 Worker 日志并处理 `pending` 记录。保存成功后，后台清理同一收件箱中接收时间超过 30 天的邮件及其 R2 对象。

## 部署准备

- Cloudflare 中已有 `e-com.cc` 区域，并已启用 Email Routing。
- Node.js 20+，在本目录运行 `npm install`，然后 `npx wrangler login`。
- 当前 Catch-all 转发 Gmail 的规则**先保留**，直到数据库、R2、Worker 和网页均验证完成。

## 第一次部署

在此目录执行：

```sh
npm install
npx wrangler login
npx wrangler d1 create inbox
npx wrangler r2 bucket create inbox
```

把 `wrangler.jsonc` 中 `database_id` 的 `REPLACE_WITH_D1_DATABASE_ID` 换成 D1 创建命令返回的 ID。若桶名已被占用，修改 `bucket_name` 为实际名称。`mail.e-com.cc` 如已有 DNS CNAME，先检查并移除冲突记录；Worker Custom Domain 会管理自己的 DNS 和证书。

初始化 D1：

```sh
npx wrangler d1 execute inbox --remote --file=./schema.sql
```

如果数据库已用旧版 `schema.sql` 初始化，部署新版 Worker 前执行一次：

```sh
npx wrangler d1 execute inbox --remote --file=./migrate-read.sql
```

先部署网页 Worker。**此时配置里故意没有 `addresses`，不会接管现有 Catch-all：**

```sh
npx wrangler deploy
```

打开 `https://mail.e-com.cc/inbox/test`，应显示空邮箱；打开 `/rand`，应得到随机地址。也可以运行 `npm test` 检查路由和转义逻辑。测试收信可参考 [Cloudflare 本地邮件模拟文档](https://developers.cloudflare.com/email-service/local-development/routing/)。

**如果主要给中国大陆用户使用：切换邮件规则前，务必用大陆的移动、联通、电信网络分别实测 `mail.e-com.cc` 的首页、列表、详情和附件下载。** Cloudflare 全球网络在中国大陆可能出现较高延迟或不稳定；Cloudflare 中国网络是单独的 Enterprise 服务。若实测不可用，先调整网页部署位置，再切换 Catch-all。邮件接收的 MX 与网页主机名是不同的配置，网页不可访问不等于收信必然失败。

## 最后切换 Catch-all

确认网页与绑定正常后，给 `wrangler.jsonc` 的 `r2_buckets` 行末加逗号，并在其下一行加入：

```json
"addresses": ["*@e-com.cc"]
```

再次运行 `npx wrangler deploy`，阅读 Wrangler 展示的路由变更并确认接管现有 Catch-all。切换后，邮件只进入本 Worker，**不再转发 Gmail**。到 Cloudflare Email Routing 的 Routing rules 页面确认 Catch-all 动作为本 Worker，再从外部邮箱向 `abc.chatgpt@e-com.cc` 发一封测试邮件，检查 `https://mail.e-com.cc/inbox/abc.chatgpt`。历史 Gmail 邮件不会自动导入。

## URL

| URL | 内容 |
| --- | --- |
| `/rand` | 直接返回随机邮箱地址；名字为 5–24 位小写字母、数字，短名字优先 |
| `/inbox/abc.chatgpt` | 全部邮件，按接收时间倒序；`[*]` 未读、`[ ]` 已读、`[!]` 疑似垃圾邮件 |
| `/inbox/abc.chatgpt/12` | 第 12 封；删除后返回 404，序号不复用 |
| `/inbox/abc.chatgpt/latest` | 仍存在的最新一封 |
| `/inbox/abc.chatgpt/12/attachments/1` | 下载附件 |

`/rand` 仅查询 D1 中是否已有该用户名，撞名就重试；**它不预留名字**。尚未收到邮件的随机地址可能再次被生成，并发请求也可能得到同名地址。收件人大小写不敏感，统一小写。邮件同时发给多个本域名地址时，按各自的收件地址分别存储、编号。只依据 `X-Spam-Flag: YES` 或 `X-Spam-Status: Yes` 标记“疑似垃圾邮件”；没有这些标头不代表安全。标记不会阻止接收或自动清理。

## 手动清理

自动清理只在同一收件箱收到新邮件时触发。没有新邮件的收件箱不会自动清理，需要手动处理。清理失败会写入 Worker 日志；状态为 `deleting` 的邮件会在下次该收件箱收到邮件时重试。

可以通过 Cloudflare D1 控制台或 `wrangler d1 execute inbox --remote --command="..."` 查询：

```sql
SELECT mailbox, seq, subject, received_at FROM messages
WHERE spam_suspected = 1 AND status = 'ready'
ORDER BY received_at DESC LIMIT 100;
```

删除前，先查 `attachments.object_key` 与 `messages.body_key`，在 R2 中删除相应对象；然后删除 D1 中的附件行和邮件行。R2 键格式为 `mail/收件人/序号/...`，便于定位。**只删 D1 不会释放 R2 附件空间。** `mailboxes.next_seq` 不要清零或减小。`pending` 代表保存失败或尚未完成，需要检查 Worker 日志和 R2 对象后再清理。

## 限制与维护

- 邮件是公开的，知道收件人名字的人可枚举所有序号和下载附件。
- Cloudflare Email Routing 的入站邮件大小上限目前为 25 MiB；超限邮件在进入 Worker 前被拒绝。[邮件限制](https://developers.cloudflare.com/email-service/platform/limits/)
- D1 单行上限为 2 MB，因此 1 MiB 以上正文转存 R2。[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- 收件箱收到新邮件时清理该收件箱超过 30 天的邮件；长期没有新邮件的收件箱需要手动清理。没有按垃圾邮件标记单独清理的规则。
- 目前邮件解析库会把整封邮件读入内存；大邮件处理受 Worker 内存/CPU 限制。若日志显示处理失败，应调整方案或 Worker 计划。
- 本项目不发送邮件。若将来要恢复转发，需要明确修改 Worker 和 Cloudflare 路由。
