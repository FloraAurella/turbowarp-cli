# 持续隔离运行与调试

本域只有命令、JSON结果和独立 Node 24 fork；不启动浏览器、Electron或前端。不把运行变量、坐标、克隆或输入写回编辑VM/SB3。显式绑定的本地云文件仍是即时共享状态，不属于项目回滚范围。

## 生命周期

在 `tw session` / `tw session --jsonl` 内使用（一次性进程退出会dispose其运行副本）。

```text
open demo.sb3
runtime start --paused --seed 1234
runtime status
runtime step
runtime step 5
runtime step --frames 30
runtime resume
runtime pause
runtime stop
```

- `start` 加载当前编辑快照，绿旗启动，默认解释器。运行中再次 `start` 拒绝；先stop。`--paused` 在绿旗初始化之后、第一帧之前暂停，以便精确设置断点/观测。
- `resume` 连续以指定FPS安排虚拟帧；`pause` 等待当前帧完成并停止后续调度。计时器读取虚拟帧时间，暂停墙钟不计入Scratch wait/timer。它不是stopAll。
- `stop` 调用stopAll，删除克隆/线程/问题队列，dispose replay/VM/renderer/audio，然后退出fork；控制器等待退出后返回。再start从当前编辑快照重新开始，不沿用旧运行变量。
- `status` 返回state、零基frame（已完成帧数/下一帧）、虚拟timeMS、stage尺寸、fps、编译模式、原始targets、threads（ID/current block/stack）、cloneCount、pendingQuestion和权限边界。非运行或已关闭时也可status/stop。
- 默认运行生命期5分钟（暂停也计入），`--lifetime 秒` 可设1..3600。最大100000帧；`--max-frames N` 可降低。达到帧限自动暂停并拒绝resume，生命期到期dispose退出。
- 继承session runtimeSettings的compiler/warpTimer/volume和当前FPS/Turbo；`--compile` / `--no-compile`显式覆盖编译器，`--fps 1..240`、`--turbo`覆盖当前值。项目中较低clone limit保留；较高/无限clone limit钳至300，不通过设置解除此资源限制。

## 解释器单步与断点

```text
runtime start --paused --no-compile
runtime breakpoint add 积木ID
runtime breakpoint add 积木ID --target 角色ID
runtime breakpoint list
runtime step --frames 1
runtime breakpoint hits
runtime step
runtime breakpoint remove 积木ID
runtime breakpoint clear
```

`step [count]`每次执行一个解释器primitive边界，默认count=1，范围1..10000。嵌套非shadow reporter也算一次：reporter执行后保留其缓存值，再次step执行父命令，不重复抽随机数。无primitive的shadow/初始化hat不单独算一步。过程/分支保持原解释器stack；循环/等待yield会推进一个虚拟帧。可用 `--thread 线程ID`选择解释线程（否则优先上次线程再选可运行线程）。不能单步monitor线程。

`step --frames N`推进1..10000帧，与block count/thread互斥；支持编译模式。帧可能被断点或operation预算打断，返回实际 `steppedFrames`，未完成帧不会冒称完成。block单步只有paused状态可用。

断点按原始角色ID+block ID保存，在primitive执行之前暂停，记录frame/timeMS/threadId/targetId/originalTargetId/blockId。同一sprite的clone执行共享积木也命中，targetId标识真实clone。继续或step仅绕过当前命中一次，下一次循环仍命中。`hits [--limit N] [--since 序号]`读有界命中日志。

**明确限制**：compiled block step、block breakpoint、逐primitive trace拒绝，不静默降级；可重启 `--no-compile`。hat谓词在上游startHats初始化内求值，不能对已发生的绿旗/键盘hat求值做执行前断点。静态shadow没有primitive边界。调试钩子只在worker内编译冻结execute/sequencer片段，源码锚点改变立即失败，不写依赖文件。

## 变量/列表观测与trace

```text
runtime watch add 得分
runtime watch add 变量ID --target 角色ID
runtime watch list
runtime watch samples --limit 20
runtime watch remove 得分
runtime watch clear
runtime trace on --limit 1000
runtime trace get --limit 50 --since 10
runtime trace events
runtime trace off
runtime trace clear
runtime clones
```

watch名称/ID优先当前或指定target，找不到再查舞台全局。clone ID也可指定。最多32个watch；每个保留256条、最多1 MiB。返回不可变值快照、frame/timeMS/reason；添加时记录初值、frame结束记录一次、block step记录变化。日志淘汰旧数据会明确增加dropped，不无限增长。已销毁clone的watch保持描述但不能恢复clone。

`trace on --limit N`启用解释器primitive日志，capacity1..10000；每条含sequence/frame/timeMS/targetId/originalTargetId/threadId/blockId/opcode。默认1000条、最多4 MiB。`get`不清除，`off`仅停止记录，`clear`清primitive及事件日志；序号保持递增。`trace events`读问题/回答、greenFlag、pause/resume、clone created/failed、断点和资源限制事件（最多256条/4 MiB），编译模式也可读这些事件。

`clones`返回实时clone ID、originalId、位置、可见性和本地变量，不把clone当成可保存的编辑角色。status含线程和clone计数，没有GUI性能图表。

## 按帧输入与ask

```text
runtime input key space down --frame 2
runtime input key space up --frame 3
runtime input mouse 0 0 down --button 0 --frame 4
runtime input mouse 40 10 up --frame 5
runtime input wheel 0 -120 --frame 6
runtime input username player --frame 0
runtime answer '预定回答' --frame 10
runtime status
runtime answer '当前回答' --question 1
```

所有输入帧均为**绝对零基帧**，在该帧_step之前投递；不能排到已完成的过去帧。不带frame的输入由worker以收到串行请求时的next frame赋值，不依赖过期status。鼠标快捷命令用Scratch舞台坐标（+y向上），worker/replay使用canvas坐标；button为0..2，move不改变按键状态。

也可传经过device-adapters严格校验的JSON event。

```text
runtime input '{"frame":3,"device":"keyboard","data":{"key":"ArrowLeft","isDown":true}}'
```

设备白名单为keyboard/mouse/mouseWheel/userData/cloud/video/loudness/gamepad。媒体仅inline经校验的记录数据，不接受路径、URL、脚本、未知IO设备。复用单一createInputReplay，append先decode/validate再原子入队，按帧apply，退出统一dispose。旧session.inputs的 `{device,data}`按frame0兼容；总4096事件/16 MiB inline/32 MiB decoded预算由adapter执行。

ask不自动回答空字符串。status.pendingQuestion返回id/text/targetId/frame；即时answer要求有当前问题，`--question`防止答到过期prompt。按帧answer可在问题出现前排队：到该帧之后第一个符合questionId的pending question消费一次。上游ask Promise由ANSWER解决，后续primitive在下一step/帧执行。回答队列累计4096条/4 MiB，每条最多10000字符。

## 隔离与可靠性

- 控制器固定worker文件和当前Node24执行器，移除继承的NODE_OPTIONS/NODE_PATH/execArgv，不允许输入指定可执行代码或worker路径。
- 子进程加载前安装default-deny网络；Project限制可执行扩展，设备adapter拒绝真实摄像头/麦克风/硬件通道；拒绝未知IPC字段/动作/输入，不放宽安全边界。这不是OS任意JS沙箱。
- 单控制器串行IPC，最大64条队列，单请求5秒、启动30秒超时。自动心跳检测无人发命令时的失联/卡死；超时SIGKILL，清理pending，不复用状态不明的worker。
- 正常stop先清理native资源再退出；session.dispose同步SIGKILL并reject未完成请求。fork断开IPC/SIGTERM/SIGINT自行dispose退出。控制器观察close，失败不会留可重用假runtime。
- 解释器每帧最多100000 primitive，超过暂停并记录；响应超过8 MiB明确失败，建议较小watch/trace查询。编译/原生primitive内部卡死由主进程heartbeat timeout杀死，不宣称可抢占任意native代码。

## 批量run兼容和集成契约

旧 `run` 使用plain IPC输入与frames/threads/questions/targets/png/noDOM/seed/watch结果，仍为一次性独立fork；persistent协议为 `tw-runtime-v1`，二者不混用。batch已接createInputReplay和runtimeSettings，旧frame0 input保持兼容。batch仍默认自动回答ask（未给answer时空字符串），与persistent交互ask刻意不同。

```text
run --frames 6 --seed 1234 --watch 得分 --trace 1000
```

批量 `--trace N` 接受1..10000条capacity，返回额外 `trace:{mode:"interpreter-primitives",entries,dropped,capacity,bytes,sequence}`，与持续primitive trace相同的执行边界。每条有零基frame/timeMS/threadId/targetId/originalTargetId/blockId/opcode；monitor更新不记入。真实clone保留自己的targetId和原sprite ID。日志最多4 MiB，淘汰旧条目并增加dropped；result包含PNG/base64、targets、watch与trace的JSON总计不得超过8 MiB，超限明确失败并dispose，不能当作截断的成功结果。

批量trace只复用解释器hook和BoundedLog，不启用PersistentRuntime或后台调度。不带 `--trace` 不新增trace字段；seed/watch原有结果、运行副本隔离和帧顺序不变。显式 `--compile` **或继承 `settings compiler true`** 时trace拒绝；不能为了拿trace而静默切换解释器。静态shadow及hat初始化限制与持续调试一致。

模块 `/src/runtime-commands.js` 导出：

```js
{specs: {runtime: {start: {min: 0, max: 0, options: [...]}, /* 子命令 */}},
 booleanOptions: ['paused', 'no-compile'],
 requiresProject(command, args), mutates: false,
 preflight(session, command, args, options),
 execute(session, command, args, options), dispose(session)}
```

min/max不计子命令；入口路由负责参数/白名单。只有start requiresProject；其余操作使用session.runtimeController。dispose为同步入口。controller可直接 `await start(sb3Buffer, options)`、`await request(action,data)`、`await stop()`，`closePromise`用于测试/异步收尾。

主线程batch run spec接收 `trace` 数值选项，在send前校验capacity与继承compiler并发送 `traceLimit`。worker仍在边界独立验证二者，防止直接IPC绕过。模块 `preflight` 必须在核心 `--project` 打开之前调用：已有live runtime、新建参数数值/形状错误、编译/trace冲突先拒绝，不能错误返回后已经把编辑项目替换。execute自身也做preflight防直接模块绕过；此模块不自建CLI入口。

## 实验收与仍缺口

测试 `/test/runtime-control.test.js` 使用真实CommandSession.execute、JSONL CLI、SB3、fork、变量/列表、clone、primitive trace、SIGSTOP/SIGKILL与实际超时；不是只测函数返回。运行 `Node24 --test test/runtime-control.test.js`。

已对照census stage.run/keyboard/pointer/question与addon.pause/debugger的运行语义。仍未实现/未宣称完成：

- debugger addon自定义log/warn/error/breakpoint扩展opcode兼容、日志模板文件导出、GUI定位/图表；当前为原生CLI调试，不加载不可信addon代码。
- breakpoint条件表达式、反向执行、time-travel、编译器积木级trace/step、并行线程精确GUI单步调度对拍；thread选择与frame推进的定义以上文为准。
- 实时声音播放时间线/暂停音频输出/视频编码；offline audio不是已渲染的音频时间线。warp/异步音频/日期/外部云输入不保证全部确定性。
- 媒体录制duration/delay、waitGreenFlag/endOnStop、项目音频和预录麦克风混合、帧录制开始/结束条件、完整视频文件输出；不能把配置保存当录制验收。
- Windows/Linux、极端native资源耗尽和操作系统沙箱。
