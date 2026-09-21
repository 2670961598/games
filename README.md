# GAMES — 指尖游戏平台（竖屏刷玩小游戏站）

4399 × 抖音：纯手机端竖屏小游戏信息流，无限上滑刷玩。

- 洗牌袋规则：全部游戏刷完一遍后才允许重复
- 目标规模：100+ 可全程游玩小游戏，每个类型 ≥ 5 款，带关卡与数值差异
- 玩家可上传游戏，经审核管线纳入游戏大全
- 个人信息页：玩过的游戏 / 时长 / 历史再进
- 高并发优先，只适配手机端

## 快速开始

```bash
npm install        # 安装依赖（vite + typescript）

npm run dev        # 开发：server(4399, API) + vite(5173, 热更新, /api 代理)
                  # 手机同局域网访问 vite 打出的 Network 地址真机调试

npm run build      # 构建：web/ → dist/（哈希资产，可 immutable 缓存）

npm start          # 生产：node server/index.js 伺服 dist/ + games/ + /api
                  # 默认端口 4399（PORT 可覆盖），绑定 0.0.0.0（手机可访问）

npm run smoke      # 冒烟：临时端口拉起 server，断言 /api/health → {"ok":true}
npm run typecheck  # TS 类型检查
```

## 目录结构

```
server/    API + 静态服务（Node 原生 http，零运行时依赖：ETag/304、br/gzip 压缩、
           /assets/* immutable 缓存、keep-alive 65s 长连接、SPA 回退、games 伺服）
web/       前端源码（Vite + TypeScript，手机竖屏 only）
dist/      构建产物（git 忽略，npm run build 生成，由 server 伺服）
games/     自包含游戏目录 games/<type>/<slug>/（见 games/README.md）
scripts/   dev / 冒烟脚本
docs/      探索与设计文档
```

> 端口备注：默认端口选 4399；本机 8787 回环被 studio-daemon 控制台占用
> （macOS 允许 0.0.0.0 与 127.0.0.1 同端口并存绑定，server 会“监听成功”但流量被截）。

本仓由 Studio AI 团队框架（YouTrack GAMES 项目 + studio-daemon + Claude Code）全流程生产。
