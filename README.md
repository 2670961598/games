# GAMES — 指尖游戏平台（竖屏刷玩小游戏站）

4399 × 抖音：纯手机端竖屏小游戏信息流，无限上滑刷玩。

- 洗牌袋规则：全部游戏刷完一遍后才允许重复
- 目标规模：100+ 可全程游玩小游戏，每个类型 ≥ 5 款，带关卡与数值差异
- 玩家可上传游戏，经审核管线纳入游戏大全
- 个人信息页：玩过的游戏 / 时长 / 历史再进
- 高并发优先，只适配手机端

本仓由 Studio AI 团队框架（YouTrack GAMES 项目 + studio-daemon + Claude Code）全流程生产。

> 架构约定：**零构建**。web/ 为原生 ES 模块（浏览器直接 import），server/ 为 Node 原生 http
> 零运行时依赖；`npm run build` 是"拷贝 + 校验"式构建（见 scripts/build-web.js），
> 在一个只有 Node 的检出上也能确定变绿。早先的 Vite+TS 方案已在基线对齐时移除。

## 快速开始（零依赖，只需 Node ≥ 18）

```bash
npm run build       # 构建 web/ → dist/（拷贝+校验，无需 npm install）
npm start           # 启动 server → http://127.0.0.1:4399
npm run smoke       # 后端冒烟：API/上传/统计管线断言（隔离临时目录，不碰真实数据）
npm run smoke-feed  # 前端冒烟：洗牌袋/时长统计/清单完整性/游戏大全（分页+过滤）断言
```

手机同局域网访问：`HOST=0.0.0.0 npm start`。

开发（免构建直跑 web/ 源码）：`npm run dev`（`WEB_DIR=web` 强制前端根回退源码目录）。

> 端口备注：默认端口选 4399；本机 8787 回环被 studio-daemon 控制台占用
> （macOS 允许 0.0.0.0 与 127.0.0.1 同端口并存绑定，server 会“监听成功”但流量被截）。

## 目录结构

```
web/            前端（原生 ES 模块，无框架无构建依赖）
  src/            feed / 我的页 / 游戏大全 / 播放器 / 洗牌袋 / 时长统计 / 上报
server/         后端（Node 原生 http，零运行时依赖）
  index.js        静态托管 + 游戏/统计/上传 API（/api/games /api/play-events 等，见下）
  lib/            scan-games（清单扫描，含 levels/tier）/ stats / uploads / dedup / shuffle / 限流 / zip
scripts/        build-web.js（构建）/ smoke-feed.js（前端冻结验收冒烟）
                 smoke-api.js（后端冒烟）/ bench-api.js（压测）
games/          自包含游戏目录：games/<type>/<slug>/{index.html,game.json}
  demo/          5 款占位小游戏（点击得分类，feed 联调用）
```

## 关键机制（前端）

- **feed 滚动**：CSS scroll-snap + 保留式 DOM + IntersectionObserver 懒挂载 + LRU iframe 池（方案选型实测见 `docs/explore/feed-scroll.md`）
- **洗牌袋**：访客级（localStorage 持久化袋状态），随机不放回，袋空重装；目录增删自动 reconcile 且不破坏"一轮不重复"
- **时长统计**：游戏可见计时、切走/隐藏暂停（drain 增量落账，无双计），localStorage 持久化 + 批量上报 `/api/play-events`（后端不可达时仅本地）；事件带 `cid+seq` 客户端身份，重发/重试由服务端幂等去重，不重复计时
- **游戏来源**：`/api/games` 动态扫描 `games/` 目录（新增游戏目录重启即上架）；前端显式大页拉取全量清单（服务端默认 `pageSize=20`，超 20 款时按 `total` 自动翻页拼全）
- **游戏大全**（`#/catalog`，feed 左下入口）：按页消费 `/api/games`（type 交服务端过滤；tier 档位为客户端二次过滤，跨服务端页攒满逻辑页避免整页滤空）；24 类型与五档选项以 `docs/game-design-spec.md` §6/§3.1 为唯一事实源（`web/src/browse.js` 的 `TYPE_CATALOG`/`TIER_GROUPS`）

## 后端（server/，零运行时依赖，Node ≥ 18）

```bash
npm start                  # http://127.0.0.1:4399
node scripts/smoke-api.js  # 冒烟验收（隔离临时目录，不碰真实数据）
```

### API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活检查 `{ok:true}` |
| GET | `/api/games?page&pageSize&seed&type` | 游戏大全：分页 + seed 服务端洗牌袋；每项含 `id/slug/type/name/levels/tier/url`；`Cache-Control: public, max-age=30` + ETag 304 |
| POST | `/api/upload` | 玩家上传（zip / 单 html / multipart 表单），限速每 IP 10 次/分钟（429+Retry-After） |
| GET | `/api/uploads` ｜ `/api/uploads/<id>` | 待审列表 / 单查状态（台账末态） |
| POST | `/api/uploads/<id>/approve` | 待审 → 上架：移入 `games/<type>/<slug>/` 并写 `game.json` 清单 |
| POST | `/api/uploads/<id>/reject` | 待审 → 驳回（body 可带 `{reason}`） |
| POST | `/api/stats` | 时长上报 `{visitorId, gameId, seconds}` 或 `{events:[…]}`；别名 `/api/play-events` 兼容 sendBeacon（`ms` 自动换算秒）；幂等：事件可带 `cid+seq`（序号窗去重），旧形状按 `(visitorId,at,gameId,s)` 指纹去重，重发丢弃并计 `dropped` |
| GET | `/api/stats/<visitorId>` | 玩过列表（每款秒数/次数/最近时间）+ 累计时长 |

**seed 洗牌袋语义**：同一 seed → 全列表的稳定排列（刷新/翻页不乱序），翻完一整圈才会重复；换 seed 即换一袋。纯函数实现（fnv1a+mulberry32），跨进程/重启稳定。

**上传校验**：大小上限 2MB（`UPLOAD_MAX_MB`）；HTML 结构检查（必须含 `<html>` 根元素；`<script src>` 只允许相对路径或白名单外域，`UPLOAD_SCRIPT_HOSTS` 配置，默认 jsdelivr/unpkg/cdnjs/esm.sh）；zip 拒绝加密/zip64/路径穿越条目，条目数与解压总量封顶（防 zip bomb），CRC32 逐条校验。状态机 `pending → published | rejected`，流转记录追加 `server/data/uploads.jsonl`。上传元数据（`type/slug/name/levels/tier`）可走 query 参数或 multipart 字段。

**跨域关闭**：全站不输出任何 CORS 头，且 `Origin` 与 `Host` 不一致的请求直接 403（仅同源）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `4399` / `127.0.0.1` | 监听地址 |
| `GAMES_DIR` / `DATA_DIR` | `games/` / `server/data/` | 数据根（测试/隔离用） |
| `UPLOAD_MAX_MB` | `2` | 上传大小上限 |
| `UPLOAD_RATE_PER_MIN` | `10` | 每 IP 每分钟上传次数 |
| `UPLOAD_SCRIPT_HOSTS` | 主流公共 CDN | script src 外域白名单（逗号分隔） |
| `WEB_DIR` | 自动（dist 优先） | 前端静态根 |

### 高并发措施与单机预估 QPS

措施：keep-alive 65s；文本响应按 `Accept-Encoding` 协商 gzip/brotli（流式，低档位）；静态指纹资源（`/assets/*`）`immutable` 一年长缓存，其余 ETag+304 协商；`/api/games` 服务端 3s 内存缓存 + `max-age=30` + ETag 304。

单机预估（Mac mini M 系实测，`scripts/bench-api.js`，32 并发 keep-alive；12 款为压测时临时填充的清单规模，空清单下 /api/games 更快）：

| 路径 | 压缩 | 实测 RPS |
|---|---|---|
| `/api/health` | — | ~66,000 |
| `/api/games`（12 款） | brotli | ~24,000 |
| `/api/games`（12 款） | 关 | ~46,000 |
| 游戏入口 html（3KB） | brotli | ~23,000 |

压测方法：

```bash
npm start                                          # 或指定规模另起实例
node scripts/bench-api.js /api/games /api/health -d 10 -c 32   # 内置零依赖压测
# 或用 autocannon 交叉验证：npx autocannon -c 32 -d 10 http://127.0.0.1:4399/api/games
```

浏览器侧实际负载更低：`/api/games` 带 `max-age=30` 与 ETag，多数轮询落在浏览器/CDN 缓存上（304 约为全量响应成本的 1/20）。上传/统计为追加写 JSONL，无锁、崩溃安全（损坏行读取时跳过）。
