# 联机协议规范（net-protocol v1.1 · M0 冻结）

> 单据 GAMES-40（E6/M0 联机基座）+ GAMES-41（M1 测试 API/net.api 规范，§8）。本文是联机基座的
> **唯一协议事实源**：房间生命周期、feed schema、WS 消息格式、S1 帧协议完整定义、S2-S7 预留扩展位。
> **冻结纪律**：后续 21 款联机游戏一律按本文接入；任何字段/语义变更需 PM 批（开单走协议变更流程，
> 版本号 +1 并在 §10 变更记录留痕）。事实源上游：docs/multiplayer-roadmap.md。

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
- **断线重连**：真人断开 → 席位保留 10s（+1 拍宽限——托管转换逐拍判定，gap ≤ 10s+本游戏 1 拍
  的复席必先于转换落地，边界确定不靠帧相位运气，GAMES-63 F2' 口径）；客户端凭 `roomId + seat + token`
  （welcome 下发的接管凭证）重连，服务端下发全量 `state` 重同步后继续 lockstep。逾时：席位转 bot 托管
  （有 bot 可用）或空置至终局。
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

### 4.3 welcome 帧锚语义（join 锚 = 当前 tick，而非局首）〔GAMES-74 口径披露〕

`welcome.frame` 的语义按入房时点分两式（`started` 恒为 `frame:0`）：

- **开赛前入房**（waiting 房）：`welcome.frame = 0`，随后 `started{frame:0}` 对齐局首——时间线锚=局首。
- **join 运行中房 / 重连**（live 房）：`welcome.frame = 加入时刻房间的当前 tick`（随附 `state` 即该 tick
  全量态）。**这不是局首**：客户端若按 `welcomeAt − frame × tickMs` 重建时间线，得到的是"假设房史
  零欠帧"的推算局首，而非真实开赛时刻。

**口径警示（GAMES-73 QA2 O1 实测）**：长周期房房史若有欠帧跳账（tickLive stepCap 跳齐不追账），
上述推算锚存在**系统性恒值平移**（实测 2 局 +568/+768ms，帧间隔本身稳定），且平移量随房史累积、
不可从单端观测还原。因此：

1. **联机延迟取证勿用绝对滞后**（`welcomeAt − frame×tickMs` 对真值的偏差无界）——用两臂对照
   （同房两客户端差分）或帧间隔分布作判据；
2. 开赛在场客户端（`started`/liveAt 锚）不受影响，可作对照臂；
3. 协议增强候选（未实现，非缺陷）：`welcome` 附带服务端 `liveAt` 时间戳，供 join 端重建真实时间线。
   列入后续协议变更单评估，v1.1 不动字段。

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

## 6. S2-S7 预留扩展位（S2/S3/S4/S5/S7 已实证；S6 仍为预留）

| 扩展 | 预留位 | 状态 |
|---|---|---|
| S2 状态同步 | 消息 `t:'snapshot'`（`{frame, base, ents:[…]}` 全量/增量二式）；`frame.ext.snapSeq` | **已实证**（mmo-township，GAMES-52） |
| S3 混合 | `frame.ext.layer:'build'\|'battle'` 分层标记 | **已实证**（empire-sprout，GAMES-68） |
| S4 物理权威 | `welcome.room.physics:{engine,hash}` 声明块；`snapshot.ext.physics` | **已实证**（pool-physics，GAMES-78；payload：`physics={engine:'pool-int-v1', hash:fnv1a32(TRIG16+ATAN8+常量表)}`；`snapshot.ext.physics={engine,hash,sub}`——球动期 10Hz，`balls:[[id,x,y,pot],…]` 全量/`[id,x,y]` 增量二式、`snapSeq` 每 300 张强制全量；静止期事件驱动零快照。hash 不符 → 客户端回退插值渲染模式（版本护栏）） |
| S5 回合权威 | 消息 `t:'op'`（玩家操作上行）/ `t:'ruling'`（裁决下行）；`frame.ext.turn` | **上行 `t:'op'` 与下行 `t:'ruling'` 已实证**（pool-physics 复用承载，GAMES-78；`op{shot\|place\|concede}` 一次性指令经 sim 权威校验（非法 `{k:'reject'}` 事件回流）；`ruling={t,frame,turn,phase:'aim'\|'motion',timerMs,openTable,groups,ballInHand,shot?,events,state}`——`shot` 携带确定性重演全部输入（客户端本地 60fps 重演同款 sim，快照逐字节校验锚））；**S5 本格实证**（element-duel，GAMES-88：回合状态机 pick→mulligan→play 全事件化 ruling、每 op 附**全量个性化 state**（迷雾下发：己方牌面/对方张数/观战双隐藏，sim 可声明 `personalize(room,ctx,msg)` 钩子由 rooms 广播层逐连接换视图——目录首款按角色裁剪）、零快照纯事件驱动（无 snapshot 消息）、`welcome.room.duel={engine,hash}` 版本护栏、超时托管（casual 单回合/牌组风格持续/`op{host}` 主动托管）、断线重连 welcome 全量个性化恢复、回放器=重放 `{seed,picks,ops}` 输入日志==在线终态 stateHash——确定性红线首证）；`frame.ext.turn` 未用（回合态在 ruling 内） |
| S6 海量实体 | `snapshot.ext.aoi:{x,y,r}` 兴趣域声明 | 预留 |
| S7 预测+和解 | `frame.ack`（服务端确认的输入序号）+ `t:'reconcile'`；预留 client prediction 与 `frame.hash` 校验位 | **已实证**（speed-kart，GAMES-109；payload：`snapshot.ext.ack`=本连接已消费输入 seq（per-connection）+`snapshot.ext.hash`=每 10 张己车权威态 `fnv1a32(tick:x,y,a,d,v,s,laps,cp)` 帧拍校验哨兵+`snapshot.ext.pd={d,s,cp}` 己车增量补全（12B/张，和解回滚完整态）+`welcome.room.prediction={engine:'kart-int-v1',tickMs:50,hash}` 声明块（不符→客户端回退纯插值）；客户端本地预测=单源 sim 同式 integrate 20Hz+输入环形缓冲（上行 `input.frame=seq` 20Hz 心跳兼保活），和解=ack 锚定回滚+重放未确认（Δ≤6px 软收敛/硬回滚 120ms 混合带）；`t:'reconcile'` 未用（sync 消息+全量快照覆盖同语义）；`t:'sync'` 复用 §4 全量通道） |

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

## 8. 测试 API 与 net.api 声明规范（GAMES-41 · v1.1）

> 制作人指令：**操作全 API 注入可驱动整局，可玩性可程序验证**（roadmap §4.2「API 可玩」红线）。
> 每款联机游戏 DEV 单自跑 `scripts/api-check.js <gameId>` 通过才可交付；QA 单必跑。

### 8.1 网关测试管理端点（实现：server/gateway/testapi.js）

| 端点 | 请求 | 应答/语义 |
|---|---|---|
| `POST /api/test/room` | `{gameId, seed?, botLevels[]?, timeScale?, startDelayMs?, maxTicks?, hp?}` | 建隔离测试房 + API 玩家自动入座首个 `null` 席（botLevels 按 seat 下标：`null`=API 席，档位字符串=bot 席）；返回快照（§8.1 末） |
| `POST /api/test/input` | `{roomId, seat?, op, payload?}` | 注入一条操作。`op` ∈ net.api.ops（游戏操作）∪ 框架控制 op（§8.2）；返回 `{receivedAt}` 供延迟断言 |
| `GET /api/test/state` | `?roomId=&since=<cursor>` | 状态快照 + 下行消息账本增量（`events:[{ts,msg}]`，`cursor` 前移；单次至多 512 条） |
| `DELETE /api/test/room` | `{roomId}` 或 `?roomId=` | 立即回收测试房（正常/异常路径都必须清理） |

- **鉴权（唯一）**：仅监听来自 `127.0.0.1`/`::1`/`::ffff:127.0.0.1` 的请求；其余来源（局域网/公网）一律 `403 local-only`。端点**不发 CORS 头**——浏览器跨源天然不可达，测试面不暴露公网。
- **隔离**：测试房（`room.test` 标记）不进 `/api/matches` feed、不被 `quick` 命中（WS join 按 `room-gone` 处理）、不计 BotHost 常驻配额；并发上限 8 房。
- **与真人同路径（红线）**：API 玩家是一条虚拟会话（`conn.send` 只记账本），入房走 `RoomManager.join`、操作注入走 `RoomManager.input`（同一条 sanitize/lastInput/pending 帧入口）、掉线走 `detach`——与 WS 会话逐字节同一条代码路径（§4/§5）。
- **假时钟倍速**：`timeScale`（0.25–16）只缩放 live 帧推进节奏（`tickMs/timeScale` 定频、追帧上限同倍放大），帧内容与真人房同构；`timeScale=1` 时与原语义逐字节一致。`seed` 钉死确定性地图（缺省仍按 roomId 派生）。
- **快照字段**：`{ok, roomId, gameId, phase, frame, tick, timeScale, playerSeat, token, seats, state, result, events, cursor, lastInject}`；`result` 与协议 `end` 消息同形（`{winner, scores, reason}`），终局后仍可读（8s 展示窗内）。

### 8.2 框架控制 op（连接生命周期也走 API）

| op | payload | 语义 |
|---|---|---|
| `$disconnect` | — | 模拟掉线（与 WS close 同路径：席位进入 10s 重连窗，`goneAt` 计时） |
| `$reconnect` | `{token}` | 凭 welcome 下发的 token 复席（与 `join resume` 同路径）；席位已转 bot 托管或 token 不符 → `409 resume-rejected` |
| `$sync` | — | 全量重同步（与 WS `sync` 同形，账本入一条 `state` 消息） |

游戏 op 的 payload 即对应 WS 消息体（S1：`{mx,my,fire}` 输入向量，可包 `keys` 壳/可选 `frame` 预约帧）。

### 8.3 net.api 声明规范（game.json `net.api` 节）

每款联机游戏在 game.json 声明（范式见 `games/multiplayer/net-tank/game.json`）：

```json
"net": { "tech": "S1", "gameId": "…", "mode": "…", "seats": 4,
  "api": {
    "spec": 1,
    "ops":        { "<op名>": { "ws": "input", "keys": ["mx","my","fire"], "desc": "…" } },
    "ctlOps":     ["$disconnect", "$reconnect", "$sync"],
    "endState":   { "phase": "ended", "winner": "'A'|'B'|'draw' 语义", "teams": { "A": [0,2], "B": [1,3] }, "reason": "…" },
    "assertions": ["A1…A5 摘要"],
    "script": {
      "seed": 20260926, "timeScale": 4, "startDelayMs": 600, "maxTicks": 1200,
      "scenarios": {
        "win":  { "botLevels": [null, "casual", "competitive", "casual"], "expectWinner": "A", "policy": "hunt-nearest" },
        "lose": { "botLevels": [null, "competitive", "casual", "competitive"], "expectWinner": "B", "policy": "idle" }
      }
    }
  } }
```

- `ops`：op 清单 → WS 消息映射（S1 即 `input` 输入向量；S5 回合制游戏未来映射 `op` 消息，扩展位）。
- `endState`：胜负终态断言依据（`teams` 给出席位→队伍映射，供报告标注 API 席所属队）。
- `script.scenarios`：至少 `win`/`lose` 两剧本——deterministic seed + bot 档位 + 假时钟倍速 + 期望胜方 + 玩家策略 `policy`。策略注册表在 `scripts/api-check.js`（`idle`/`hunt-nearest`…，新游戏在此登记或复用）。
- 缺 `net.api` = 不可 API 验证，DEV 单不得交付（api-check 退出码 2 拒跑）。

### 8.4 api-check / net-check 分工

| 工具 | 面 | 覆盖 |
|---|---|---|
| `scripts/api-check.js <gameId>` | **API 面**（零浏览器，逻辑可玩性） | L1 仅本机 + A1 能开始 + A2 能赢 + A3 能输 + A4 注入→帧反映 <100ms + A5 断线重连 <10s；JSON 报告落盘 kernel 证据路径；退出码可挂闸门 |
| `scripts/net-check.js` | **浏览器面**（真 Chromium） | 大厅渲染/点击入房 <2s/bot 让位/feed 新鲜度/满员旁观/断线重连复席/识图截图（375×667） |

浏览器仅用于 visual 支柱（识图终审协议 v2）；可玩性判定以 api-check 为准（更快、确定性、可入 CI 闸门）。

## 9. 网关启动运维（附录）

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

## 10. 变更记录

| 版本 | 日期 | 单据 | 变更 |
|---|---|---|---|
| （无版本变更） | 2026-09-28 | GAMES-74 | §4.3 新增：welcome 帧锚语义文档化（join 锚=当前 tick 而非局首；欠帧跳账致推算锚恒值平移的取证警示）。**既有字段/语义零改动**，纯口径披露，不触发版本号 +1 |
| v1.1 | 2026-09-26 | GAMES-41 | 新增 §8 测试 API（仅回环鉴权的测试房管理端点/框架控制 op/net.api 声明规范/api-check 与 net-check 分工）；房间管理器支持 seed/test/timeScale，测试房隔离（不进 feed/quick/BotHost 配额）。v1 全部既有语义不变（timeScale=1 逐字节一致） |
| v1 | 2026-09-26 | GAMES-40 | 首版冻结：生命周期/feed/WS/S1 帧协议/S2-S7 预留/SDK/运维 |
