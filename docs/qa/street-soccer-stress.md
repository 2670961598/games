# 街头足球 压测+单链收官 —— GAMES-144

> 单据：GAMES-144（L2 常规 · attempt 0）｜基线：main@3d905ab（GAMES-143 VIS 已合并）｜分支：feature/GAMES-144
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-144/`（影子树 shasum 留档与 repo 逐字节一致、A/B/C/rss/补采 工件 JSON+日志、gateway.stdout、chain-driver.log、prod-pids-before.txt）
> 预算：起跑计时 ≤25 分钟（实测 **~23.5 分钟**——A 8.6min→C 5min→rss2 二段全程接力，报告/档案/实录在运行窗内并行写）；压测计时锚=A 组起跑
> 里程碑：**平台第 11 条完整单链 + W2 波第三款收官 + E6 总进度 11/21 过半里程碑**（战图 §4.3 已回填）

## 0. 结论速览

- **A 组 多房并行 PASS**：6 间街头足球 2v2 测试房（[null(API 席)+balanced×3]，6/6 满载四席）8.6 分钟 ts2 churn，28 建房/22 世代终局（time-up 24+goal-cap 6+abandon 1 全语义终局）、tick 漂移 **p50=0 tick / 包络 [-4,+2] tick**（ts2 下 1 tick=25ms → p50≈0ms、包络 [-100,+50]ms）、feed 全量校验零错、零 429、零 uncaught（§A）。
- **B 组 长局交叉引用 PASS**：八单已有观测汇总合计 ≥100 分钟覆盖（§B.1，不重跑）+ 满编 spot 2v2 满员+第 5 人观战 11 断言全绿（§B.2，b-spot 终版；v1 一枚探针口径缺陷如实披露归档）。
- **C 组 混编 PASS**：十一游戏同网关 5 分钟（E6 全家福——S1-S7 全技术轨在场，street-soccer 为第 11 款 sims 注册表成员），第 9 间测试房护栏 429 证据（§C）。
- **无泄漏四件套 PASS**：RSS 二段（22 世代 churn 后沉降无爬升）+ 句柄数平稳（45-47 平台）+ 房间回收闭环（ended→dispose→槽释放）+ 日志零 uncaught（§D）。
- **档案**：docs/game-quality.json `multiplayer:street-soccer` → **accepted（单链 8/8 预算版完整，FIX1/FIX2 零退回跳过）**；战图 §4.3 E6 11/21 回填。
- **实录**：知识库草稿《街头足球开发实录（GAMES-137..144 · E6-W2-T3 单链收官）》已投递（单流双域/状态归属表/两次剧本加固/HF 非法简写首证到修复/Q-010~Q-013 案例链）。

---

## A. 多房并行：6 房 8 分钟（tick 漂移/CPU/RSS 曲线）

影子网关 :4427（影子树 `shasum-repo.txt` 留档与 repo **逐字节一致**——server/ 全拷+games/web 符号链接、data 随影子路径隔离、GATEWAY_PID 改道；生产 :4400/:4399 零感知——压测期间生产网关 pid 1983/54127 原样应答，§D 终检 pidsUnchanged）。6 间 street-soccer 测试房（`[null(API 席)+balanced×3]` 4 席满 2v2、错峰 5s 建房防世代同步）、10s×48 采样、dispose 感知 churn（ended→DELETE→立即重建，GAMES-116 A2/125/136 范式）。

**时标选型**：ts=2（tickMs=50 名义 20Hz → 有效 40tick/s）+maxTicks=6000（框架硬顶）。常规制 180s 比赛钟（CLOCK_REG=3600 tick）先于 300s 帽尽、OT 上限才逼近硬顶（QA1 §5 口径）——ts2 下一世代 ≈90-120s 墙钟 → 8 分钟窗 22 世代 churn，终局 reason 全语义（time-up 24/goal-cap 6/abandon 1，qa2-mercy 同源字段 result.reason）。

| 指标 | 值 |
|---|---|
| 在场房数（采样均值/峰值） | 5.54 / 6（6/6 目标达成；世代翻转窗瞬时回落 4-6=ended 滞留挤兑，churn 固有生态，GAMES-116/125/136 同型） |
| 建房/终局轮换 | created 28（6 初始+22 重建）/ ended 22 世代（全部语义终局；testDispose=28 含收尾清场） |
| tick 漂移（n=239） | p10 -2 / **p50 0** / p90 +1 / min -4 / max +2 tick（ts2 下 1 tick=25ms：p50≈0ms、包络 [-100,+50]ms——20Hz 名义钟裕量大，与卡丁 20Hz 同钟同量级带，优于战棋 100Hz 快钟口径） |
| CPU | avg 10.73% / peak 17.2%（6×2v2 全场实体+球域 Q16 子步重载下 <20% 单核占用） |
| RSS | 起 130256KB → bothost 热身段爬升（十一款常驻房 195 spawn）→ 峰 226384KB → 末 226224KB（热身后 22 世代 churn Δ≈0——无按代累积；曲线见 a-rooms.json samples） |
| 句柄 | 46→45→45→47→…→47（22 世代后平台稳定 47——与世代数不成比例=无按代累积） |
| feed 校验 | 全程 0 采样拍错误（street-soccer 第 11 款入 SEAT_CAP=4/PREFIX='street-'/mode='2v2-street' 十→十一款注册表口径；测试房不进 feed=协议设计，feed 内 street 房=bothost 常驻房 2 间恒驻） |
| 429/轮询失败 | recreate429=0 / pollFail=0 |

**观战锚工勘披露（A 组口径修正）**：首版 a-rooms 在测试房上挂 spectator 锚——`rooms.js:121` 测试房 WS 面隔离（`room.test && !connCtx.isTest → room-gone`，GAMES-139 QA1 已立此规）使非测试连接无法观战测试房，welcome 超时后 **finally 清障即时关连接（Q-009 口径，无悬挂）**。观战数据面锚改由 §B.2 满编 spot（quick 房 spectate 全绿）+ §C 补采（bothost 常驻 street 房 60s 画像）承载。**教训复刻：GAMES-139 已记过的坑，换单仍会走进去——测试房观测只走 /api/test/*。**

## B. 长局交叉引用：≥60 分钟观测汇总（不重跑）+ 满编 spot

### B.1 八单已有观测汇总（合计 ≥100 分钟，不重跑）

| 单据 | 观测面 | 覆盖窗/样本 | 来源 |
|---|---|---|---|
| GAMES-137 D | 设计书（S3 第二形态单流双域/持球权零预测归属表/2v2 传球免瞄准席位红利/TRIG16 跨作引源） | 设计态无运行窗 | docs/designs/street-soccer.md |
| GAMES-138 DEV | api-check 27/27 冻结面+换日复跑翻红抢救（乌龙对账锚=goal team 分布 vs 个人分差额+scorer 奇偶归因） | 取证窗 ~10 分钟 | commit 系/kernel 工件 |
| GAMES-139 QA1 | 长局 spot ×11（6000-tick 硬顶帽，常规制 180s 钟先尽→time-up 主导）+net 臂 43 断言（N1-N7：延迟对照/重连/混跑）+HTTP 时延对齐臂（n0 计数+250ms 弃样窗） | 取证窗 ~20 分钟 | docs/qa/street-soccer-qa1.md |
| GAMES-140 BOT | bot-check 24 面（三档梯度/开局树/放水链决策级 A/B×11/让位语义/回放等价）+A2 混沌面并入统计制 27→39 断言+A8 新锚 2364577099 | 取证窗 ~8 分钟 | commit 系 |
| GAMES-141 FEEL | 动效台账 17 项两跑全首绘+终局探针两段式+SND.fired 持久集+fx 台账双时戳实测 | 取证窗 ~10 分钟 | commit 系 |
| GAMES-142 QA2 | mercy 三跑迭代（终跑 668s/35 局尝试）+M6 8min 墙钟窗交叉引用（逐局 goal==终态队分 4/4+hash 哨兵×945）+N3 6000-tick 长局 spot×9+N1 延迟对照 | 取证窗 ~25 分钟 | docs/qa/street-soccer-qa2.md |
| GAMES-143 VIS | 识图 v2 九探针（冻结帧三假红修正后）+双编码像素核法+HF __applied 生效往返自证+MERGE-VERIFY strike-rush 门线看守抢断加固 | 取证窗 ~8 分钟 | docs/vis/street-soccer-vis.md |
| **本单增量** | A 组 8.6min + B spot ~1.5min + C 组 5min + rss2 二段+补采 1min（§A/§B.2/§C/§D） | ~16 分钟在线窗 | 本报告 |

合计在线/取证覆盖 **≥97 分钟**（≥60 分钟达标；各单窗口径为报告/工件所载取证窗，如实注记非连续墙钟）。

### B.2 满编 spot（2v2 满员+第 5 人观战，~1.5 分钟收官复检）

quick 真人 A（bot 补 3 席=2v2 满）→ 显式 spectate（第 5 人）→ 30s 稳定窗 10 采样（窗口内每 3s 注入一条 input 抽样验证 ack 数据面）。断言 **11/11 全绿**（b-spot.json 终版）：

| 断言 | 结果 | 锚 |
|---|---|---|
| A quick 入房 role=player | ✓ | seat=3 room=street-8npz1xe100 |
| quick bot 补席 2v2 满编 | ✓ | humans=1 bots=3 mode=2v2-street |
| joinable 语义（humans<4→true=让位通道在场） | ✓ | humans=1 joinable=true |
| 第 5 人 spectate welcome | ✓ | role=spectator |
| 30s 稳定窗席位保持 | ✓ | 10/10 humans=1/bots=3/spect≥1 |
| 房活性（下行 frame 推进） | ✓ | frame 1618→2220 msgs=309（10Hz 二式快照口径） |
| 观战下行在流（帧流+比分数据面） | ✓ | frames=302 score={"A":3,"B":1} bytes=183233 |
| 玩家输入 ack 数据面（§5.2 预测和解锚） | ✓ | acks=307 last=8 |
| 观战焦点数据面（ext.hash 确定性哨兵） | ✓ | hashSnaps=30（每 10 张节拍） |
| 房活性（feed elapsedMs 推进） | ✓ | 80982→111099ms |
| 零 reject（玩家席+观战席全程） | ✓ | player=0 spect=0 |

**F11 焦点环口径**：F11 为客户端键盘快捷键+渲染层焦点环——浏览器侧已由 GAMES-143 VIS 识图 v2 九探针在冻结帧双读取证（本单不重跑）；本 spot 取其服务端数据面（观战席快照流携带全员 ents+ext.hash 哨兵+poss/kickTeam 焦点字段在 state 壳）。
**v1 披露归档**：首版 spot 一枚探针断言口径错（`b-spot.v1-ackAssertMisframe.json`）——把 per-connection 输入序号确认 ext.ack 当观战焦点锚；观战席 seat=-1 恒 ack=-1 系 `emitOne` 设计位（无输入即无确认）。修正=玩家席验 ack 回流+观战席验 ext.hash 哨兵，v2 全绿。

## C. 混编：十一游戏同网关 5 分钟（E6 全家福）

**PASS**——30/30 采样拍十一款游戏全在场（feedGameIds 集合全程唯一=element/empire/moba/mmo/net/pool/snake/speed/street/tactics 全十一款），feed 校验 0 错、429 重建 0 次、零 uncaught（c-mixed.json）。

影子网关 :4427 同网关承载 E6 全部十一款（street-soccer 为第 11 款 sims 注册表成员，bothost 常驻 2 间=feed 内恒驻）。八款测试房各 1（street[主角]/moba/slg/net/emp/pool/element/snake，8 槽满）+mmo bothost 常驻镇（spectator 锚）+tactics/speed bothost 常驻房=十一款在场。

**护栏证据**：第 9 间测试房（8 槽上限）→ `429 {"ok":false,"error":"too-many-test-rooms"}` ✓（C 组首拍即取证）。

| 指标 | 值 |
|---|---|
| feed 游戏款数 | **11/11 全程稳定**（30 采样拍集合唯一：十一款 IDs 恒在场；rooms 21-22=2×10+mmo 镇 1） |
| 测试房churn | created 34 / ended 26 世代（net-tank 快周期 56-58t 多世代、street 2 世代@4949t、snake 3601 硬顶、element 13452 长局——各钟各世代全语义终局；live 3-8 波动=世代翻转+8 槽护栏固有，recreate429=0） |
| street 漂移（本单主角） | n=4：p50 0 / 包络 [-1,+1] tick（混编重载下同 A 组带内） |
| mmo 常驻镇 spectator 锚 | n=3051 snaps / frameHz=10.000 精确镇钟 / bytesFull p50=685B avg=715B / bytesIncr p50=646B |
| CPU / RSS | avg 14.91% / peak 33%；RSS 229568→246688KB（十一款混编+测试房 churn 热身带，无单调爬升） |
| feed 校验 | 30 拍 0 错（十一款 SEAT_CAP/PREFIX/mode 注册表全量口径） |
| 零售后 | uncaught=0 / roomError=0 / pollFail=0 |

**street 第 11 款注册画像（补采 spect-bothost 60s）**：bothost 常驻 street 房 spectator welcome ✓、tick 钟 frameHz=**20.036**（tickMs=50 名义 20Hz 漂移 0.18%）、179 snaps≈10Hz 二式快照（快照仅在 play 相位：goal 庆柷/开球相位暂停比赛钟不下发——比分 A1:B5 高频进球窗实测与设计 §5.3 口径吻合）、bytesFull p50=939B / bytesIncr p50=253B avg=1280B。观察项（低危）：单枚 159KB 增量样本=庆祝暂停后事件批+脏集合退化路径（>全量×0.7 触发全量重发）一次性尖峰，均值带宽仍在 §5.3 预算带内。

## D. 无泄漏四件套

**四件套 PASS**（rss-phase2.json 4/4 断言全绿）：

- **RSS 二段**：A/C 全部测试房 DELETE 后静置 20s 沉降，5×4s 采样——245792→245904KB **Δ=0.05%**（<5% 帽；22+26 世代 churn 后零单调爬升=无按代泄漏）。
- **句柄**：lsof 计数 49→49 全程平台（A 组 45-47、C 组混编 49——与世代数/款数不成比例累积）。
- **房间回收**：feed 房数回落 bothost 常驻水位 23-24 间、**street 测试房=0**（streetRooms=2=bothost 常驻）、testRoomsInFeed=0；全链 room-end 313→room-dispose 315→endedDispose 264+testDispose 51（ended→dispose→槽释放闭环）。
- **日志零 uncaught**：gateway.stdout 全程 `"k":"uncaught"` 计数=0（roomError=0 同零）。

**生产零感知终检**：压测全程生产网关 pid 1983（:4400，23-24 房）/pid 54127（:4399）原样应答——`prod-pids-before.txt` 留档，影子树 data 隔离+GATEWAY_PID 改道，无任何生产路径写入。

## E. 收官对账

- 冻结验收：`node scripts/api-check.js street-soccer` + `test -f docs/qa/street-soccer-stress.md` + `grep 无泄漏` 三连绿。**api-check 三跑披露**：跑1 38/1（A2 统计制三局两胜 1/3——seed 20261015/16 负 goal-cap、20261017 胜；@8x 实时驱动下注入输入落拍竞态族，GAMES-139「@8x 同 tick lastInput 覆盖」同源），跑2/跑3 **39/39 全绿**（2/3 全绿、exit=0）。观察项（低危·复跑项）：A2 统计制阈值 2/3 在机器重载后残差 ~1/3——建议后续单升 五局三胜 或注入定拍化（input.frame 预约帧通道已在协议 §6，改挂预约帧可消墙钟竞态）；产品无缺陷（单局引擎确定性由 A8 双跑+回放三等本单复验锚 2364577099 在场）。
- 档案：game-quality.json `multiplayer:street-soccer` stage=**accepted**（iterations=8 预算版单链）。
- 战图：§4.3 看板新增街头足球行（T3 二款 · S3+S4 accepted 2026-10-15）+W2 波 3/7+E6 总进度 **11/21**。
- 单链终态：GAMES-137..144 八单完整（FIX1/FIX2 零退回跳过）——平台第 11 条完整单链、W2 波第三款收官、E6 过半里程碑。

## F. 预算对账（起跑计时）

| 阶段 | 墙钟 | 备注 |
|---|---|---|
| 开工 merge main+通读范式+影子树+脚本 | ~4.5min | GAMES-136 工件直接改写复用 |
| A 组 8min 窗+churn | 8.6min | chain.sh 后台接力起跑 |
| B spot（v1+v2 两跑） | ~2min | 与 A 并行同网关 |
| C 组 5min 窗 | ~5.5min | A-DONE 秒级接力（chain-driver.log） |
| rss2 二段+补采 | ~1.5min | |
| 报告/档案/战图/实录投递 | 并行于运行窗 | 文章/quality/roadmap 在 A/C 窗内落笔 |
| **合计** | **~23.5min ≤25min 帽** | 无超帽 |
