# 联机协议规范（net-protocol v1 · M0 冻结）

> 单据 GAMES-40（E6/M0 联机基座）。本文是联机基座的**唯一协议事实源**：房间生命周期、feed schema、
> WS 消息格式、S1 帧协议完整定义、S2-S7 预留扩展位。
> **冻结纪律**：后续 21 款联机游戏一律按本文接入；任何字段/语义变更需 PM 批（开单走协议变更流程，
> 版本号 +1 并在 §9 变更记录留痕）。事实源上游：docs/multiplayer-roadmap.md。

## 1. 拓扑与端口

```
浏览器 ──HTTP──▶ :4399 静态服务（存量不动；multiplayer.html 大厅 + 游戏页）
       ──WS/HTTP─▶ :4400 实时网关（独立 Node 进程，HOST=0.0.0.0，绝不触碰/重启 :4399）
```

- 网关 HTTP：`GET /healthz`、`GET /api/matches`（CORS `Access-Control-Allow-Origin: *`，大厅跨端口拉取）。
- 网关 WS：`ws://<host>:4400/ws`（任何 path 均可升级，约定 `/ws`）。客户端用 `location.hostname` 自适应（LAN 可玩）。
- 实现：Node 原生 `http` + 自研最小 RFC6455 WS（`server/gateway/lib/ws.js`，零新依赖；不引 ws 库、无 permessage-deflate）。

## 2. 房间生命周期

```
waiting ──(满最低人数或倒计时到)──▶ live ──(胜负判定/超时)──▶ ended ──(8s 后回收)──▶ 删除
   │                                    │
   └── 空置无人 120s 回收               └── 真人掉线：席位保留 10s（重连窗），逾时转 Bot 托管或空置
```

| 状态 | 语义 | feed 可见 |
|---|---|---|
| waiting | 已建未开赛（倒计时/等人） | 是，joinable |
| live | 对局进行中，帧广播中 | 是，joinable=席位可入 |
| ended | 已出结果，结算展示 8s | 否 |

- 席位 seat：`0..N-1` 整数（net-tank N=4；`team = seat % 2`，A=偶数席 B=奇数席）。
- 席位类型 kind：`human` ｜ `bot`（bot 带 `level`: `casual|balanced|competitive`）。
- **真人加入让位**：满员 bot 房来了真人 → 服务端选一个 bot 席（优先 seat 最大的 bot 席）就地接管
  （`kind: bot→human`，该席 bot 消失，真人继承当前比分/位置），广播 `seat` 名册；无 bot 席可让且满员 → 进 `spectate`。
- **断线重连**：真人断开 → 席位保留 10s；客户端凭 `roomId + seat + token`（welcome 下发的接管凭证）重连，
  服务端下发全量 `state` 重同步后继续 lockstep。逾时：席位转 bot 托管（有 bot 可用）或空置至终局。
- 旁观：不占席、只收帧；`spectators` 计数进 feed。

## 3. feed schema（GET /api/matches）

```json
{
  "ok": true,
  "serverTime": 1729000000000,
  "matches": [
    {
      "roomId": "nt-a1b2c3",
      "gameId": "net-tank",
      "name": "净斗坦克 · 竞技房",
      "mode": "2v2-team",
      "humans": 1,
      "bots": 3,
      "spectators": 0,
      "elapsedMs": 63400,
      "joinable": true,
      "url": "/games/multiplayer/net-tank/index.html"
    }
  ]
}
```

- 刷新口径：大厅 3s 轮询（红线：变化 5s 内可见）；`url` 为游戏页路径，大厅自行追加 `?room=<roomId>&gw=<网关 origin>`。
- `joinable`：`waiting|live` 且真人席位数 < 总席位数（有 bot 可让或空位）。
- 时间字段一律 epoch 毫秒（`serverTime`/`elapsedMs`），客户端用 §4 时钟同步换算显示。

## 4. WS 消息格式（JSON 文本帧，UTF-8）

约定：`t` = 消息类型；`frame` 从 0 起（0 = 初始态）；seat 用数字键的对象表示席位映射。

### 4.1 客户端 → 服务端

| 消息 | 字段 | 说明 |
|---|---|---|
| `hello` | `{t, v:1, gameId?}` | 可选握手；v 不符服务端回 `error{code:'version'}` 并容忍继续 |
| `join` | `{t, roomId, mode:'play'\|'spectate', resume?:{seat,token}, name?}` | 入房/重连（带 resume 即重连语义） |
| `quick` | `{t, gameId, level?}` | 快速匹配：选一个 joinable 房加入，无则建房（BotHost 补 bot） |
| `input` | `{t, frame, keys:{mx,my,fire}}` | S1 输入向量；mx/my ∈ [-100,100] 整数，fire ∈ {0,1} |
| `ping` | `{t, c}` | c = 客户端 epoch ms；服务端原样回 pong |
| `sync` | `{t}` | 客户端检测到缺帧时请求全量重同步（服务端回 `state`） |
| `leave` | `{t}` | 主动离席（触发重连窗逻辑） |

### 4.2 服务端 → 客户端

| 消息 | 字段 | 说明 |
|---|---|---|
| `welcome` | `{t, roomId, gameId, role:'player'\|'spectator', seat?, token?, frame, tickMs, seed, room:{name,mode,state,countdownMs,seats:[{seat,kind,level?,name?}]}, state}` | 入房确认 + 全量初态（重连/中途加入同形） |
| `started` | `{t, frame:0, state}` | waiting→live：开赛（waiting 房客户端先见 welcome 后见 started） |
| `frame` | `{t, frame, inputs:{<seat>:{mx,my,fire}}, events:[…], over?:bool}` | S1 帧（§5）；`over:true` 为末帧 |
| `state` | `{t, frame, state}` | 全量重同步（重连恢复/纠偏） |
| `seat` | `{t, seats:[{seat,kind,level?,name?}]}` | 席位名册变更（bot 让位/托管/加入） |
| `end` | `{t, frame, result:{winner:'A'\|'B'\|'draw', scores:{A,B}, reason}}` | 终局；reason ∈ `eliminated\|timeout\|abandon` |
| `pong` | `{t, c, s}` | s = 服务端 epoch ms；客户端算 RTT 与时钟偏移 |
| `error` | `{t, code, message}` | `room-full`/`room-gone`/`bad-msg`/`version`/`game-unknown` |
| `closed` | `{t, reason}` | 房间回收前告知（客户端回大厅或快速匹配） |

## 5. S1 帧同步协议（冻结 · net-tank 首证）

- **定频**：服务端按 `tickMs`（net-tank=100ms）逐帧推进；帧 `F` 携带第 `F` 帧全席位输入向量。
- **输入时机**：客户端收到帧 `F` 后立刻上报 `F+1` 帧输入（input delay=1）。LAN RTT 下一次 tick 前可达；
  服务端**输入宽限 40ms**：帧到点仍未收到的真人席位沿用其上一帧输入（最慢者定帧的宽容版，防卡死）。
- **确定性纪律**（红线）：
  - 判定路径零 `Math.random`；初始布局由 `seed = fnv1a32(roomId)` 经 `mulberry32` 生成（§5.6 纪律逐字沿用）；
  - 模拟状态全整数（毫单位：位置 milli-px），只有 `+ - * >>`（除法结果取整）等 IEEE754 确定运算；
  - 帧输入量化为整数后才入模拟（`mx/my` [-100,100] int、`fire` 0/1）——客户端模拟量 UI 到此为止。
- **服务端权威**：网关同样逐步跑模拟（裁判 + Bot 决策依据），终局以服务端判定为准；客户端模拟仅作呈现。
- **事件流**：`frame.events` 携带表现性事件（`{k:'hit',seat,by,hp}` / `{k:'die',seat,by}` / `{k:'shot',seat}`），
  客户端可零 diff 触发特效；事件是模拟结果的下发冗余，不作为状态源。
- **终局**：eliminated（一队全灭）/ timeout（到 `maxTicks` 按存活 HP 定胜负，平则 draw）/ abandon（全员离线 15s）。

### Bot 决策

Bot 输入由服务端 Bot 宿主逐帧生成（`spawnBot(gameId, level)` 接口），走与真人完全相同的输入通道下发——
客户端无感知、无需复现 Bot 随机源。三档 `level`（casual/balanced/competitive）参数见各游戏 sim 文件头。

## 6. S2-S7 预留扩展位（v1 只定义不实现）

| 扩展 | 预留位 |
|---|---|
| S2 状态同步 | 消息 `t:'snapshot'`（`{frame, base, ents:[…]}` 全量/增量二式）；`frame.ext.snapSeq` |
| S3 混合 | `frame.ext.layer:'build'\|'battle'` 分层标记 |
| S4 物理权威 | `welcome.room.physics:{engine,hash}` 声明块；`snapshot.ext.physics` |
| S5 回合权威 | 消息 `t:'op'`（玩家操作上行）/ `t:'ruling'`（裁决下行）；`frame.ext.turn` |
| S6 海量实体 | `snapshot.ext.aoi:{x,y,r}` 兴趣域声明 |
| S7 预测+和解 | `frame.ack`（服务端确认的输入序号）+ `t:'reconcile'`；预留 client prediction 与 `frame.hash` 校验位 |

规则：新增消息类型一律先在本文登记；`ext` 对象向后兼容（未知键客户端必须忽略）。game.json 侧以
`net.tech`（S1-S7）声明本款采用的同步技术，QA 按此核验。

## 7. 客户端 SDK（games/_shared/net.js）

联机游戏页唯一网络出口（HTTP/WS 一律经它）；页面自包含铁律不变——SDK 由构建期内联进游戏页
（`server 对 /games/_* 一律 404`，无外链可能）。

```js
GNet.gwOrigin()                       // 由 location 推导（默认 <scheme>://<hostname>:4400，?gw= 可覆盖）
GNet.connect({ url, roomId|quick, gameId, mode, level, resume, onWelcome, onFrame, onState,
               onSeat, onEnd, onError, onStatus }) → session
session.sendInput({mx,my,fire})       // 自动标 frame=已收最新帧+1
session.close() / session.rttMs / session.offsetMs / session.status
```

- 时钟同步：每 2s ping/pong，RTT 与偏移取近 5 次中位数；`offsetMs` 供 HUD 对时。
- 自动重连：意外断开即退避重试（0.5/1/2/4s），带 resume 凭证；10s 窗内恢复自动续局，超窗回调 `onStatus('lost')`。

## 8. 网关启动运维（附录）

与 :4399 同口径 nohup 常驻（**绝不触碰/重启 :4399**；两进程互不依赖）：

```bash
cd <repo>
HOST=0.0.0.0 nohup node server/gateway/index.js > server/data/gateway.log 2>&1 &
# 验活：curl -sf http://127.0.0.1:4400/healthz && curl -sf http://127.0.0.1:4400/api/matches
# 停机/重启（仅网关）：kill $(cat server/data/gateway.pid) 后再按上式拉起（index.js 自写 pid 文件）
```

- 端口/绑定可用环境变量覆盖：`PORT`（默认 4400）、`HOST`（默认 0.0.0.0）。
- BotHost 自启：网关启动即为每个已上线联机游戏常驻 bot 房（net-tank 常驻 2 房：casual/balanced），
  终局后 3s 自动补房，总量上限 4 房/游戏。
- 日志：`server/data/gateway.log`（一行一 JSON：房间事件/连接/错误）；pid 文件 `server/data/gateway.pid`。

## 9. 变更记录

| 版本 | 日期 | 单据 | 变更 |
|---|---|---|---|
| v1 | 2026-09-26 | GAMES-40 | 首版冻结：生命周期/feed/WS/S1 帧协议/S2-S7 预留/SDK/运维 |
