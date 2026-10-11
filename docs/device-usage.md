# 离线设备输入、权限和 ScratchLink fixture

本模块提供 D7 **预录数据注入**，而不是实时摄像头/麦克风/OS 手柄采集。输入必须由调用者显式给出文件、非 TTY 管道或纯 JSON；不会枚举设备、扫描蓝牙、连接网络或执行输入里的 JavaScript。

## 命令

以下 `tw` 指项目的 `tw` 启动脚本，使用 Node 24。连续运行使用 `tw session`；所有 `device` 输入统一采用 **仅入队、runtime 副本生效** 的语义。命令读取/验证数据后加入瞬态 `session.inputs`，包括第 0 帧在内也不向 editor VM 投递。不改 editor 的 cloud 变量、键鼠 IO、username、传感 provider，不触发键盘/鼠标/wheel/gamepad hats 或创建 editor threads；不会把 PCM、照片或手柄状态写进 SB3。

```text
device capabilities [--output capabilities.json]
device permissions
device permission camera deny
device input-list [--output inputs.jsonl]
device video-frame frame.png [--frame 0] [--mirror false] [--output event.jsonl]
device loudness sensor.wav [--frame 0]
device loudness sensor.pcm --format s16le --sample-rate 44100 --channels 1
device loudness 50
device gamepad '{"index":0,"buttons":[true,0.25],"axes":[0.8,-0.2]}'
device gamepad pad.json [--frame 0]
device key space down
device mouse 20 -10 down [--button 2]
device wheel -120 [deltaX]
device user-data offline-user
device cloud "☁ score" 123
device replay inputs.jsonl [--validate-only] [--output validated.jsonl]
device socket-mock [BLE|BT] [--output socket.json]
```

文件注入和键鼠命令要求已打开项目，或使用 `--project project.sb3`。`replay --validate-only` 不要求项目、不执行积木、不安装 provider；它检查 JSON、所有媒体头和实际 PNG/JPEG 解码、累计限制。若提供项目，也验证 cloud 更新只指向已存在的舞台云变量。

`--output` 明确导出 JSON/JSONL，不是 `--out`。这些命令不接受 `--out`，不触发 SB3 编辑事务、不产生 undo 历史，也不把干净 session 标为 dirty；这是因为 editor 标准项目及资产没有改变，而不是忽略了修改。保存项目用 `save output.sb3`（或相应项目命令的 `--out`），但不会保存这份录入队列；要保留预录输入，必须 `device input-list --output inputs.jsonl`。录入结果明确返回 `appliedToEditor:false`。导出的媒体事件内联 base64，可重新回放，不是图像/WAV 转码输出。文件已存在时默认拒绝，显式 `--force` 才覆盖。

### 会话示例

```text
open project.sb3
device video-frame frame-0.png --frame 0
device video-frame frame-1.jpg --frame 1
device loudness sensor.wav --frame 0
device gamepad '{"index":0,"buttons":[true],"axes":[0.75,0]}' --frame 0
device input-list --output recorded-inputs.jsonl
run --frames 8 --fps 30 --watch measuredMotion
```

`--frame` 从 **0** 开始，事件只在工作进程 runtime 副本的对应 `_step()` 之前生效。同帧事件保持输入顺序，但 `gamepad-mapping` 配置先于同帧 `gamepad` 数值。未写 frame 的旧 `{device,data}` 保持兼容，执行时等同第 0 帧；capture/restore 保留旧事件原始形状，不额外添加 frame 字段。**没有 editor 即时预览**，所有帧只录入队列。批量 `run`/`runtime start` 取得该队列的副本，不消费或回写 editor；启动后新增的 `device` 事件用于后续运行，不会隐式送入正在运行的副本。向正在运行的副本输入请用 `runtime input`，它使用同一验证及 append 接口，遗漏 frame 时由 worker 填入当前帧。

### cloud 与键鼠的污染边界

例如干净项目舞台 `☁ score=1`，执行 `device cloud "☁ score" 99` 后

- editor 变量、`project export`/`save` 中的值仍为 **1**，dirty 保持原值，录入本身不增加历史。
- `run --frames 1 --watch "☁ score" --target stage` 的真实 VM 副本读到 **99**；副本退出后 editor 仍为 1。
- `device replay` 含 cloud 也只有同样的 runtime-copy 效果，验证要求变量存在且为舞台 cloud；不创建 provider、不写本地 cloud 文件、不启网络。
- 累计队列的媒体/数量/JSON 限制仍检查全部事件，cloud 不被丢弃或从预算中排除。
- `device key/mouse/wheel/gamepad` 以及委派到此模块的 legacy `input key/mouse` 同样只录入。editor 不触 `KEY_PRESSED`/click/wheel hats、不建立 threads，不会随后 `_step()` 偷跑项目。runtime 副本仍按真实 VM IO 启动对应 hats，而不是取消模拟效果。

真正要编辑持久 cloud/项目变量时使用有编辑语义的项目变量命令，不使用 `device cloud`。如果其它显式编辑使项目 dirty，device 录入不会把 dirty 清掉。非持久队列退出不会有“SB3 未保存”的告警；需要留存队列必须显式导出 JSONL。

### 显式管道

源参数 `-` 表示读取 stdin 至 EOF，例如一次性验证

```sh
cat recorded-inputs.jsonl | ./tw device replay - --validate-only
```

同样支持 PNG/JPEG、PCM/WAV、手柄 JSON 的单次输入管道。禁止把数据 stdin 和 `tw session` 的命令 stdin 混用，防止吞掉后续命令；会话中改用显式文件。普通文件路径不能是 FIFO/device，管道只能通过 `-` 明确授权。管道总等待上限 5 秒。

## JSONL 契约

每行仅允许 `{frame?,device,data}`，没有路径、URL、函数、扩展源代码或用户提供的模块名。UTF-8 必须合法；frame 非负整数、非递减。

```jsonl
{"frame":0,"device":"keyboard","data":{"key":"space","isDown":true}}
{"frame":0,"device":"mouse","data":{"x":260,"y":190,"canvasWidth":480,"canvasHeight":360,"isDown":true,"button":2}}
{"frame":1,"device":"mouseWheel","data":{"deltaY":-120,"deltaX":0}}
{"frame":2,"device":"keyboard","data":{"key":"space","isDown":false}}
{"frame":2,"device":"userData","data":{"username":"offline-user"}}
{"frame":2,"device":"cloud","data":{"varUpdate":{"name":"☁ score","value":"123"}}}
{"frame":3,"device":"gamepad","data":{"index":0,"id":"recorded-pad-0","connected":true,"buttons":[true,0.4,{"value":0.8,"pressed":false}],"axes":[0.75,-0.5]}}
{"frame":4,"device":"loudness","data":{"value":50}}
```

媒体数据形状如下，`base64` 必须替换为真实文件的规范 base64（不能使用占位字符串进行回放）

- video `data: {format:"png"|"jpeg", base64:string, mirror?:boolean}`
- WAV `data: {format:"wav", base64:string, sampleRate?:integer, channels?:integer}`；如果显式给元数据，必须与 WAV 头一致。
- PCM `data: {format:"s16le"|"f32le", base64:string, sampleRate:integer, channels:1|2}`
- 固定响度 `data: {value:number}`，范围 0..100，不能同时带 PCM 字段。

JSONL 的 mouse 使用真实 VM client/canvas 坐标，不是 Scratch 坐标；`device mouse X Y` 命令则接收 Scratch 舞台坐标并转换。wheel 使用冻结 VM `mouseWheel.postData`，deltaY 负/正触发上/下箭头的 `event_whenkeypressed` hat，并不伪造 key-down 状态；deltaX 会验证保存，冻结 VM 本身不处理水平滚轮。

### 手柄数据与安全映射

手柄输入 index 为 0..3；`Gamepad_*` 积木的 pad 和 button/axis 参数仍为 **1-based**，支持相应 reporter 的 `any` 语义。

- buttons 可是 boolean、0..1 数字或 `{value:0..1, pressed:boolean}`。
- axes 为 -1..1 有限数字；不存在的按钮/轴 reporter 返回 0/false。
- 轴对死区 0.1、按钮值死区 0.05、方向保持算法按冻结 `extensions/gamepad.js` 数据语义实现；不读取 `navigator.getGamepads()`、不执行图库脚本。
- 默认安全键映射：button 0 → space，1 → enter，12/13/14/15 → 上/下/左/右；axes 0/1 在 ±0.5 外 → 左右/上下。多个手柄的按键取并集，disconnect 释放该手柄但不释放仍由其它手柄持有的键。
- `gamepad-mapping` 是固定本地映射模块验证过的纯数据事件，形状 `{frame,device:"gamepad-mapping",data:{index,id,mapping:{buttons:[entry],axes:[entry]}}}`。适配器仅消费配置，不调用 OS。key entry 包含 high/low/deadZone，mousedown 包含 button/deadZone，virtual_cursor 包含 high/low 方向、sensitivity/deadZone。光标使用冻结 GUI 的 `((abs(value)-deadZone)/(1-deadZone))² × sensitivity × deltaMS`，按每帧 `runtime.currentStepTime` 推导 deltaMS，首帧 delta=0、上限 1000ms，不依赖 `Date.now()`，夹取到舞台范围。配置/选择/export/comment 命令由 `gamepad-mapping-commands.js` 提供。
- builtin extension ID 精确为 **`Gamepad`**（大小写重要），VM 实例接点为 `runtime.ext_Gamepad`，积木 opcode 为 `Gamepad_axisValue` 等。`videoSensing`/`videoSensing_videoOn` 同理。

## 格式、大小与安全限制

| 输入 | 限制 |
| --- | --- |
| PNG/JPEG | 每帧 4 MiB；宽高各 1..2048；像素最多 2,073,600；拒绝 APNG、SVG、非图像字节；PNG chunk/CRC、JPEG SOF/EOI 在 native decode 前校验 |
| PNG chunk | 最多 4096 个，尺寸先验后解码；解码尺寸必须等于头尺寸 |
| PCM/WAV | 每个 4 MiB、最多 10 秒、8,000..192,000 Hz、1..2 channels |
| PCM 格式 | s16le 有符号 16-bit little endian；f32le IEEE float32 little endian，每样本有限且 -1..1；完整样本帧 |
| WAV 格式 | RIFF/WAVE、唯一 16 字节 fmt 和 data、PCM16 或 float32；验证 RIFF 长度、alignment、byteRate、chunk 边界；不支持压缩、RF64、WAVE_FORMAT_EXTENSIBLE |
| 普通 JSON 事件 | 64 KiB；拒绝未知字段、getter、稀疏数组、prototype pollution |
| JSONL/累计 replay | 16 MiB、4096 events、8192 行（含空行）、frame 0..99999 |
| 预解码媒体 | 每个 replay 累计最多 32 MiB；append 已消费事件仍计累计预算 |
| gamepad | 4 pads，每个最多 32 buttons、16 axes，值严格有限 |
| mock socket | 64 KiB/消息、嵌套深度 12、256 sent + 256 received/套接字、最多 16 sockets/工厂 |
| 管道 | 显式 `-`、非 TTY、5 秒总 deadline；读取期间按实际 bytes 累计，超限暂停并清理监听器 |

只接受显式本地普通文件。拒绝 URL/file URI、`..`、反斜线、控制字符、隐式 `~`、编码 traversal、设备/进程路径、文件与父目录 symlink。macOS 固定 `/tmp`、`/var` 系统别名仅在指向 `/private/tmp`、`/private/var` 时接受。读取使用 nofollow/nonblock、lstat/fstat inode 核对、有限 buffer，应对 FIFO 和读取期间增长。输出使用原子写入且默认不覆盖。

权限 camera/microphone/network/ble/bt/hid 一律默认 deny；`device permission RESOURCE allow` 明确拒绝，`camera`/`microphone`/`scan`/`connect` 失败不进行访问。显式输入文件是该文件数据的授权，**不是设备或网络授权**。模块内部只加载固定冻结 VM 与本地代码，不加载输入路径上的代码。

## 为什么传感实际有效

已读取冻结 baseline 的真实接点

- `scratch-vm/src/io/video.js`：`postData` 只影响预览透明度；像素由 `setProvider/getFrame` 提供。因此本模块安装逐 VM 的离线 provider，支持 canvas/image-data、缩放、mirror 与 native renderer 预览。
- `scratch-vm/src/extensions/scratch3_video_sensing/index.js` 及 `library.js`：使用冻结光流和实际 `videoOn`/motion hat，只把 wall-clock `_loop` 改为受控帧输入，未把 reporter 替换成假的常量。两帧前 motion=-1 为上游正常行为。sprite local motion 仍使用真实 drawable/silhouette。
- `scratch-vm/src/blocks/scratch3_sensing.js`、`scratch-audio/src/Loudness.js`：传感通过 `audioEngine.getLoudness`。PCM/WAV 下混 mono，对最多 2048 样本计算 RMS，下降值用上一帧 RMS ×0.6 平滑，`sqrt(RMS×1.63)×100`、四舍五入并上限 100；每帧失效 sensing 缓存，防止高速确定性步进读旧数值。
- `io/keyboard.js`、`mouse.js`、`mouseWheel.js`、`userData.js`、`cloud.js`：调用真实 `vm.postIOData`，cloud 只更新现有云变量、不创建网络 provider。
- GUI `lib/video/video-provider.js`、`lib/video/camera.js`、Desktop `media-device-chooser-impl.js`、`src-main/media-permissions.js`：已检查 live getUserMedia、deviceId 与枚举接点；此 CLI 不调用这些接口。
- GUI gamepad `userscript.js`/`gamepadlib.js` 与冻结图库 `extensions/gamepad.js`：分清键鼠映射与直接 reporter 路线，无 navigator/global 模拟器。

load 前 `registerOfflineExtensions(vm)` 只注册精确 `videoSensing` 和自有 `Gamepad` builtin factories，经过 extensionManager 正常 metadata/primitives 接口，不执行任意扩展。provider 无输入时为空、getLoudness=-1，视频 on/off 积木也只能操作离线 provider，不会采集。Project 的安全 allowlist 由项目模块维护。安全扩展可保存重载并由 CLI worker 执行。

runtime 接口为

```text
normalizeInput(event) / validateInput(event)       同步严格验证
validateBatch(events)                            同步累计验证
validateRecordedInputs(vm?, events)              异步预解码，不安装 provider
registerOfflineExtensions(vm)                   load 前安全 builtin factory 注册
disposeOfflineExtensions(vm)                    project 生命周期结束前清理
createInputReplay(vm, events?)                    异步全部预解码
  .append(event) / .appendMany(events)             异步、单队列、原子加入
  .applyFrame(frame)                              同步、在对应 VM step 前调用
  .dispose()                                     整个 runtime 结束时调用
```

这些 apply/replay 接口是 **runtime adapter**，不是录入命令的 editor API。`device-commands` 只调用验证/预解码接口，不创建 editor replay、不安装 provider，所以 restore 无需把旧 native handle/监听器嫁接到新 editor VM。模块 `captureState/restoreState` 保存并验证纯 JSON 队列（含传感 base64、controller/mapping IDs 和旧无 frame 形状）；与 session 的 inputs/history hooks 配合，undo、失败事务及失败 `--project` 保留对应快照中的全部非持久输入。open/new 成功则按会话语义清空队列和非持久控制器元数据；要重开继续录入，先导出 JSONL 再显式 replay。

runtime 每 VM 同时只能一个 replay；append 不创建叠加 provider。输入 append 可指定当前或未来帧，不允许倒退。applyFrame 同帧可再次调用，但不会因普通键事件重复推进光流/RMS；释放会清掉控制状态。若 Project 已安装安全边界，replay dispose 恢复该安全边界，不恢复实时设备；Project 最终 dispose 再移除边界。若独立调用 replay 首次安装了边界，dispose 恢复原 provider/方法，并清理自建 preview/listeners。

## D6 ScratchLink mock 与真实硬件未过清单

`socket-mock` 使用冻结 `util/jsonrpc.js`、`io/ble.js`/`io/bt.js` 消息分派和 runtime 的 `configureScratchLinkSocketFactory/getScratchLinkSocket`，实现 `open/close/isOpen/sendMessage/setOnOpen/setOnClose/setOnError/setHandleMessage`。

BLE fixture 固定发现 `fixture-ble` 和 `characteristicDidChange`；BT 固定发现 `fixture-bt` 和 `didReceiveMessage`。fixture 测试消息边界、生命周期、JSON-RPC request/response、冻结 BLE/BT parser 的 PERIPHERAL_LIST_UPDATE 和传感 callback；不调用 live constructor 的 window/扫描计时器，不启动本地 ScratchLink 服务、不使用 WebSocket、不连接 BLE/BT。结果明确 `mode:mock`、`realdevice.connected:false`、`acceptance:manual-not-run`。

真实硬件状态是 **limited（手动验收未执行）**，不是 D7 媒体注入的失败或全硬件对等通过。保持以下每项 scan/connect/input/output/disconnect/权限拒绝及跨平台项目回载验收未过

- micro:bit 的按钮/倾角/触摸、LED/文字输出、固件/断连；仅 fixture 消息不是实际 micro:bit sensor 协议验收。
- LEGO Boost 的颜色/距离/电机/倾角与断连。
- LEGO EV3 的 BT transport、触摸/颜色/距离/电机与断连。
- LEGO WeDo 2.0 的距离/倾角/电机与断连。
- Go Direct Force & Acceleration 的力/加速度/旋转与通知。
- Makey Makey 的实际 USB/键事件来源（离线键盘 hat 不等于实机验收）。
- 真实 gamepad HID 的控制器发现/标识/断连/平台驱动和触觉反馈。

现有 Node 依赖没有已验证 native BLE transport；本模块没有伪实现真实连接，用户即使请求权限也不会扫描/连接。mock 的固定 reply 不代表所有扩展的 firmware/output/sensor transport 协议已通过。

## 独立剩余边界

- 实时 camera/mic：刻意不采集。预录 sensor 注入已交付；GUI 的 live permission、实际 deviceId 选择和录音 acquisition 仍需实机验收。
- 手柄 GUI 选中/编辑/storeMappings 舞台 magic comment、resetControls 配置由独立映射模块负责，不能把默认固定映射冒充 GUI 配置全等；该模块测试与此传感器测试分别报告。
- 实际 rumble：本模块 fail-closed 抛 deny；**不是** addon disable-vibration 的 `vibrate=false`、`pulse=false`、`playEffect="preempted"` 兼容语义，需分别验收。
- MediaRecorder 的 duration/delay/projectaudio/micmix/waitflag/endstop、编码与音画同步不由本传感器模块实现；预录 PCM loudness 不是混音录制输出。
- JPG decoder 的色彩/EXIF 行为、完整 GUI 视频帧像素对照和三平台硬件测试不声称通过。安全格式/实际 reporter/固定 fixture 验证不等于所有媒体/硬件 GUI 操作对等。

## 验收

```sh
node scripts/node24.js --test test/device-adapters.test.js
```

测试直接读取真实 VM reporters，并运行 Scratch 脚本把帧光流、手柄轴和响度写入变量；包含 SB3 保存重载和 runtime worker，不只断言返回 injected。还覆盖 CRC/尺寸炸弹、PCM/WAV 截断/NaN/对齐、canonical base64、UTF-8/未知字段/prototype、累计内存/数量、恶意路径/symlink/FIFO/大文件、有限管道与默认拒绝设备/网络。
