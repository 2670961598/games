# GAMES — 指尖游戏平台（竖屏刷玩小游戏站）

4399 × 抖音：纯手机端竖屏小游戏信息流，无限上滑刷玩。

- 洗牌袋规则：全部游戏刷完一遍后才允许重复
- 目标规模：100+ 可全程游玩小游戏，每个类型 ≥ 5 款，带关卡与数值差异
- 玩家可上传游戏，经审核管线纳入游戏大全
- 个人信息页：玩过的游戏 / 时长 / 历史再进
- 高并发优先，只适配手机端

本仓由 Studio AI 团队框架（YouTrack GAMES 项目 + studio-daemon + Claude Code）全流程生产。

## 快速开始（零依赖，只需 Node ≥ 18）

```bash
npm run build   # 构建 web/ → dist/（拷贝+校验，无需 npm install）
npm start       # 启动 server → http://127.0.0.1:4399
npm run smoke   # 冒烟：洗牌袋/时长统计/清单完整性断言
```

手机同局域网访问：`HOST=0.0.0.0 npm start`。

开发（免构建直跑 web/ 源码）：`npm run dev`（`WEB_DIR=web` 强制前端根回退源码目录）。

## 目录结构

```
web/            前端（原生 ES 模块，无框架无构建依赖）
  src/            feed / 我的页 / 播放器 / 洗牌袋 / 时长统计 / 上报
server/         后端（Node 原生 http，零运行时依赖）
  index.js        静态托管 + /api/games + /api/play-events + /api/health
  lib/scan-games.js  扫描 games/**/game.json 生成清单（与冒烟共用）
scripts/        build-web.js（构建）/ smoke-feed.js（冻结验收冒烟）
games/          自包含游戏目录：games/<type>/<slug>/{index.html,game.json}
  demo/          5 款占位小游戏（点击得分类，feed 联调用）
```

## 关键机制

- **feed 滚动**：CSS scroll-snap + 保留式 DOM + IntersectionObserver 懒挂载 + LRU iframe 池（方案选型实测见 `docs/explore/feed-scroll.md`）
- **洗牌袋**：访客级（localStorage 持久化袋状态），随机不放回，袋空重装；目录增删自动 reconcile 且不破坏"一轮不重复"
- **时长统计**：游戏可见计时、切走/隐藏暂停（drain 增量落账，无双计），localStorage 持久化 + 批量上报 `/api/play-events`（后端不可达时仅本地）
- **游戏来源**：`/api/games` 动态扫描 `games/` 目录（新增游戏目录重启即上架）
