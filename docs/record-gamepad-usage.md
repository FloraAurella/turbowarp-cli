# 离屏录制与 Gamepad 映射

本页描述本轮已实现的命令，不表示完整 GUI 对等。所有位置参数计数不含 action。模块默认 `usesProjectTarget: false`；gamepad 的 `--target` 指控制器，不是角色。record 是 readonly，运行独立项目副本，不改变编辑项目、dirty、撤销历史或已存在 runtime。

## Record

```sh
tw record capabilities
tw record start /absolute/new-frames --project /absolute/demo.sb3 \
  --duration 2 --fps 30 --projectaudio false
```

输出目录必须显式指定、父目录必须存在且无符号链接，输出目录本身必须不存在。没有覆盖开关，不会下载、打开前端或弹权限框。每次成功生成以下文件。

- `frame-000000.png` 起的连续帧；manifest 包含 PNG header 尺寸、字节 hash、解码 RGBA 像素 hash。
- `manifest.json`，仅在帧数、PNG header/pixels、可选 WAV 和编码媒体验证完成后返回成功。
- 有显式预录轨时生成 `audio.wav`，立体声 PCM16、44100 Hz。
- `--format mp4` 或 `--format webm` 时，额外生成 `recording.mp4` 或 `recording.webm`。PNG 和 WAV 保留，便于验收。

### frozen GUI 六选项

frozen 源码位置为 `../desktop-master/node_modules/scratch-gui/src/addons/addons/mediarecorder/userscript.js`。本实现不用浏览器 `MediaRecorder`，以下默认差异不能忽略。

| CLI 选项 | 默认值 | 明确语义 |
| --- | --- | --- |
| `--duration 秒` | `1`，GUI 是 `30` | 模拟时钟截止时间，**包括 delay**；限制 ≤30 秒且总模拟步数 ≤900。不是保证录满这么多秒的视频。 |
| `--delay 秒` | `0` | PROJECT_START/录制触发后的预运行；向上量化到帧。GUI 的 duration timeout 在 delay 前启动，所以 delay 消耗 duration；必须有至少一帧捕获。 |
| `--projectaudio true\|false` | **`false`，GUI 是 `true`** | `true` 明确 `NOT_YET_SUPPORTED` 失败；没有静音成功降级。整个项目 SoundBank promise、音效/音乐和 VM clockOffline scheduling 未严格验收，是尚未交付能力，不属于 D7 麦克风例外。 |
| `--microphonemix true\|false` | `false` | `true` 必须提供 `--mic-track 文件.wav` 或 soundfiles 中 microphone 角色。仅 D7 预录替代；不访问实时麦克风。 |
| `--waitflag true\|false` | `true` | `true` 等待数据化的 `--flag-frame`（默认 0），在该帧启动项目。`false` 不暗中触发绿旗；需要时仍可显式给 `--flag-frame`。不是等待 GUI 用户点击。 |
| `--stopOnStop true\|false` | `true` | 仅 waitflag=true 时有效，监听触发后的 `PROJECT_STOP_ALL`。绿旗内部的初始化 stop 不会误终止；脚本自然执行完并不算 stop。 |

源码还有一个边界 bug：duration timeout 先启动，但 `stopRecording` 对 `recorder.state === "inactive"` 提前返回。**若 timeout 实际早于 recorder.start 执行**，停止请求被忽略，之后开始却没有该 timeout 自动停止。注意 GUI 的整数 delay 每秒只等待 **975 ms**，小数部分按 1000 ms，因此名义 `delay >= duration` 不是这个 bug 的充分条件（例如 duration=10、delay=10 可能约 9.75 秒就开始）。CLI **保守拒绝名义 delay >= duration**，要求至少一帧并保持有限输出；模拟预运行按 frame clock 而不是 GUI 的 975 ms 倒计时，不宣称这一区间的完整时长等价。

`--flag-frame` 和 `--stop-frame` 是从运行副本起点计算的 0-based 帧。`--stop-frame` 即使关闭 stopOnStop 仍停止项目脚本，但继续采图到 duration 截止。delay、绿旗等待和输出帧都计入 900 步上限。捕获在该帧设备数据应用、VM interpreter step 和异步微任务之后；首帧包含 frame zero 的脚本结果。截止点是排他的。

例：`--duration 1 --delay 0.2 --fps 10 --flag-frame 2` 等待至模拟帧 2，预运行 2 帧，从模拟帧 4 捕获，到帧 12 前结束，共 8 输出帧、0.8 秒。`--stop-frame 7` 且 stopOnStop 有效时在帧 7 的脚本 step 前停止，输出帧 4、5、6。

`--answer 文本` 自动回答项目 ask，不弹窗；默认空串。`--seed 0..4294967295` 设置独立 worker 的 Mulberry32。普通脚本每帧执行一轮调度，保留 interpreter 的 warp 防护；不宣称与浏览器高负载/turbo 编译调度等价。

项目包含 `sound_playuntildone` 或音乐的定时 note/drum/rest 时，即使 projectaudio=false，也拒绝录制，因为其阻塞 promise 时序未经严格离线验收。非阻塞声音不录入输出；它们不意味着 projectaudio 已完成。

### 外部预录数字音频

简单用法：命令直接指定文件名，只授权这一个输入文件。

```sh
tw record start /absolute/new-audio-frames --project /absolute/demo.sb3 \
  --duration 1 --audio-track /absolute/project-mix.wav \
  --microphonemix true --mic-track /absolute/narration.wav \
  --projectaudio false
```

目前支持原始 RIFF WAV 的 PCM16 或 IEEE float32，1/2 声道、8000..192000 Hz、每轨 ≤30 秒。MP3、WAV extensible 和实时 OS 设备捕获尚未支持。native `decodeAudioData` 真正解码各轨，复制 native channel samples，按样本时钟做确定性线性重采样/立体声混音，再输出 PCM16；不生成占位无声轨。

复杂映射使用 `--soundfiles /absolute/tracks.json`。

```json
{
  "version": 1,
  "tracks": [
    {"file":"project-mix.wav","role":"external","start":0,"offset":0.1,"length":1,"gain":1},
    {"file":"narration.wav","role":"microphone","start":0.2,"offset":0,"length":0.8,"gain":0.5}
  ]
}
```

- `file` 相对该 JSON 所在目录解析；拒绝 `..`、URL、控制字符、符号链接及 prototype keys。
- JSON 文件授权**不传递**给内部文件名。每个内嵌文件须精确授权，不能授权父目录、通配符或整个磁盘。
- `start` 从录制触发点计秒，不是从首个捕获帧计秒；delay 会裁掉前部音频。
- `offset` 从源 WAV 起点计秒，`length` 默认源音频剩余长度；不得超过源范围。末尾没有源的时间不重复播放，而是明确补零。所有轨与捕获区间完全无交集会失败，不会声称成功输出静音。
- `gain` 0..4；相加后限幅到 [-1,1]。manifest 包含源 SHA256、交集样本数、真实输出 RMS/peak/非零样本数/限幅样本数。源本身全零可合法输出，但 manifest 明确 `silentSource: true`，不是 silent fallback。

```sh
tw record start /absolute/new-mix --project /absolute/demo.sb3 \
  --duration 1.2 --delay 0.2 --soundfiles /absolute/tracks.json \
  --microphonemix true --projectaudio false \
  --allow 'read:/absolute/project-mix.wav,read:/absolute/narration.wav'
```

### 系统编码器精确授权

没有 PATH 搜索、下载或任意 shell 参数。默认程序虽已确认安装，也必须在每条编码命令精确授权。允许 Homebrew 的显式最终文件 symlink，但固定其 canonical realpath 和文件身份，并在每次调用前核对。父目录 symlink 被拒绝。授权可执行程序代表信任它本身；资源监控不是 OS 安全沙箱。

```sh
tw record start /absolute/new-mp4 --project /absolute/demo.sb3 \
  --duration 1 --format mp4 --audio-track /absolute/tone.wav \
  --allow 'encoder:/opt/homebrew/bin/ffmpeg,probe:/opt/homebrew/bin/ffprobe'
```

WebM 改为 `--format webm`。可用 `--encoder /exact/path/ffmpeg --probe /exact/path/ffprobe` 替换，但需要对应精确 `encoder:` 和 `probe:` 授权。也可以给 `--allow` JSON 字符串数组。frames 不需要编码器授权，也不会执行编码器。

MP4 使用 H264/AAC，WebM 使用 VP9/Opus。只接受偶数宽高的编码画面（奇数舞台请用 frames）。ffprobe 验证 codec、尺寸、实际读取的 video frame count、fps、时长以及 audio stream metadata。含音频时再次真实解码为受限 PCM 文件，验样本数和 RMS，拒绝名义上存在但静音/不一致的编码音轨。

### 资源与失败边界

整条录制命令 30 秒墙钟截止（包含加载、采图、mix、编码和验收）；总模拟帧 ≤900；worker V8 heap ≤128 MiB，worker/encoder/probe 进程组 RSS ≤512 MiB，超限或 session dispose 杀进程组并等待 close。项目运行副本 ≤32 MiB，预录 WAV 合计 ≤16 MiB、解码样本 ≤32 MiB、最多 16 轨。帧/混音输出合计 ≤256 MiB；PNG ≤4 MiB/帧、≤2048 单边、≤1920×1080 pixels；编码媒体单文件 ≤256 MiB。输出失败删除本次新建目录，不碰已有目录。

### Native RSS 根因与稳定压力证据

统一回归曾真实失败：无交集音轨本应被拒绝，却先在 worker native 初始化/释放期间触发 **518 MiB >512 MiB**，不是测试 regex 可以忽略的错误。128 MiB V8 heap 和 periodic GC 无法控制 Skia 字体 registry 的 native allocation。

只读源码与两次固定 180 帧小项目对照定位根因：`@napi-rs/canvas/index.js` 默认 `GlobalFonts.loadSystemFonts()` 并读取 `~/Library/Fonts`。NativeRenderer 虽然使用 frozen/custom 字体别名，自动发现的 host 字体仍留在全局 registry；后续字体 register/remove 重建有明显 native 峰值。以下是 macOS 当前主机的测量，不是跨平台最大值保证。

| 阶段，MiB RSS | 修复前 host 自动字体开启 | 禁止 host 自动字体，保留 pinned 字体 |
| --- | ---: | ---: |
| canvas require | 76.98 | 49.42 |
| native fonts 注册前 → 后 | 137.83 → 315.38 | 110.98 → 115.88 |
| Project.load 完成 | 321.77 | 122.45 |
| 第 180 帧 | 377.02 | 183.80 |
| dispose + GC | 549.75（native high-water 550.94） | 182.58（high-water 183.84） |

修复不提高限制，也不改变 glyph 断言：在 canvas 首次加载前启用生产 `native-environment`，record 子进程环境强制 `DISABLE_SYSTEM_FONTS_LOAD=1`，避免 OS/用户字体自动枚举；实际 frozen/custom font registration 仍由当前 NativeRenderer 完成。PNG verifier 处理后立即缩小临时 Skia canvas 到 1×1 并清除 image callbacks，返回值只持 hash/count；每四帧的 GC 和独立 worker 退出仍保留。项目/renderer/fonts 的 dispose 是成功的一部分，完成 native cleanup 后才允许发布 manifest。

manifest `memory` 包含至多 80 个 phase 样本（bootstrap、canvas require、archive、native audio、font registration、Project.load、按固定帧采样的 PNG/render/verify/release、disposed）。`peakRSSBytes` 取 OS native `process.resourceUsage().maxRSS` 高水位及采样 RSS 的最大值，包括同步调用/清理期间峰值；父线程仍监视整个进程组 RSS。超限会真实失败并标出最后阶段，不跳过、不放宽 512 MiB。

固定压力验收使用真实 **640×480 + MyPixel 自定义字体 + Serif fallback 文本 SVG**：两次 240 帧以及两轮 MP4/WebM 编码（共六次独立 worker），每次对比父 NativeRenderer 首尾 decoded pixels，真实 ffprobe frame count 和 audio PCM RMS，结束后必须所有 font families 释放为 0、无存活 child。第一次固定压力测得 native 峰分别为 **200.28、198.13、192.33、183.97、183.42、193.34 MiB**；最终完整 19-case 回归中同样六次压力的峰为 **203.17、203.48、186.53、188.34、186.39、189.66 MiB**，全部保持明显低于 512 MiB。两次长帧都额外断言后 120 帧 RSS 增量小于 24 MiB，不是循环重跑取偶然绿。

可证明全段无交集的 WAV 现在从 source header 的实际样本长度/offset/length 做 parent 预检，**创建输出目录和启动 native worker 之前**失败；测试跟踪 child registration 必须为 0。对于脚本提前 stop 导致原有音轨不再有交集，worker 的实际 captured interval 混音验证仍拒绝。另保留超限 guard 的**注入 byte sample 单元测试**：超上限一字节仍拒绝，且 phase trace 不超过 80 项。此单元测试不是实际分配 512 MiB 的 OS/RSS 压力验收；真实 native 分配与释放的证据是上述固定长帧/编码压力测量及修复前默认字体进程的 550.94 MiB 高水位。

复验命令（19 cases：record 11 + gamepad mapping 8，无 skip）为 `node --require src/native-environment.js --test test/recording.test.js test/gamepad-mapping.test.js`。

安全 VM 和当前 Project 使用已批准的 frozen/offline extension factories；不读取任意 extension code。不开放摄像头、麦克风、HID、BLE/BT 或网络。原始设备样本仍走现有 `device` 模块/worker replay。没有 browser、Electron、download 或弹窗。

## Gamepad mapping

```sh
tw session
open /absolute/demo.sb3
gamepad create controller-a --index 0 --buttons 16 --axes 4
gamepad show
gamepad set-button 0 '{"type":"key","high":"z"}'
gamepad set-button 1 '{"type":"mousedown","button":2}'
gamepad set-axis 0 '{"type":"key","high":"d","low":"a","deadZone":0.5}'
gamepad set-axis 1 '{"type":"virtual_cursor","high":"-y","low":"+y","deadZone":0.2,"sensitivity":0.6}'
gamepad store true
save /absolute/mapped.sb3
```

`create` 创建**数据控制器描述**，不连接硬件。`index` 0..3，最多 32 buttons、16 axes；默认 16/4。未给 ID 时用 `recorded-pad-N`。生成算法核对实际 frozen gamepadlib：优先从 stage/sprite key hats / key menus 推断 WASD、箭头、动作和暂停键；4-axis 控制器有两组移动/虚拟光标映射，其他 axis 数量默认空。`--empty true` 创建/重置为空映射。已有标准 comment 时默认导入其映射并按控制器长度 pad/truncate。

| action | 位置参数 | 说明 |
| --- | --- | --- |
| `create` | `[ID]` | 只注册显式 recorded controller metadata；选择首个控制器。 |
| `show` | 无 | 显示控制器、store flag、标准 comment 解析结果/错误；可 `--target 控制器`、`--output 文件.json`。 |
| `set-button` | `index JSON` | 配置 button；可 `--target 控制器`、`--frame 帧`。 |
| `set-axis` | `index JSON` | 配置 axis 正/负方向/阈值；可 `--target`、`--frame`。 |
| `select-controller` | `ID或index` | 只改变编辑/export/store 选择，不禁用其他控制器。 |
| `reset` | 无 | 按已有 comment/项目 hints 重新生成；`--empty true` 清空；取消自动 store，但保留已有 comment。 |
| `export` | `[文件.json]` | frozen-compatible `{axes,buttons}`；无路径时返回 JSON，可 `--output`，已有文件需 `--force`。 |
| `import` | `文件.json或JSON` | 数据导入、pad/truncate 到选择的控制器尺寸；绝不执行 JS。 |
| `store` | `true或false` | 开启时立即保存选择的控制器；关闭时删除首个 magic comment。 |

key names 是精确 `KeyboardEvent.key`，例如 `" "`、`"ArrowRight"`、`"Enter"`、`"z"`，不是 `"space"` alias。空值 `null`/`""` 表示未绑定。

- `key`：`high`、axis 的 `low`、axis 的 `deadZone` 0..1（默认 0.5）。
- `mousedown`：`button` 0/1/2（默认 0），axis 的 `deadZone` 默认 0.5。
- `virtual_cursor`：`high`/`low` 是 `+x/-x/+y/-y` 或空，`sensitivity` 0..100（默认 10），`deadZone` 0..1 但不含 1（默认 0.5）。cursor 速度是 frozen quadratic deadzone multiplier × sensitivity × frame deltaMS，并受舞台范围 clamp。

frozen editor 的按钮 export **删除 `low` 与 `deadZone`**。因此 set-button 不接受这两个字段，避免保存/重载时阈值悄悄变化；axis 保留这些字段。所有 JSON 字段强类型、finite，拒绝 unknown/getter/prototype、函数和任意代码。import/export 文件必须显式文件名，不自动读写默认目录。

### 标准 magic comment 与 dirty

源码已核对 suffix，精确包含前导空格：`" // _gamepad_"`。

```text
Gamepad configuration
{"axes":[...],"buttons":[...]} // _gamepad_
```

- 使用 stage 第一个包含 magic 的 comment；只解析**以完整 suffix 结尾**的第一行。尾部空格或 malformed JSON 会给 commentError，不读取其他 comment 替代。与 frozen parser 的先找到 comment/再选行行为一致。
- 首次保存创建自由 comment，x/y=50、width=350、height=150、minimized=false；已有 comment 则只替换文字，保留 ID 和布局。
- create/set/import/select **store=false 时**只改 session，不 dirty，不占历史，不写 comment。
- `store true` 后 mapping change/控制器切换将选择的 mapping 写 comment，按 frozen 保存事件语义 dirty。其他 ordinary comments 不动。
- reset 取消自动 store，但不删除 comment；因此后续 set 不改项目。store false 显式删除第一个 magic comment 时才是项目修改。
- 项目修改由 core transaction 管理 99 条历史；模块不自建历史。同步 captureState/restoreState 保存 session 控制器/选择/store flag，配合 core 恢复 inputs，失败/undo/redo 不遗漏 session 状态。
- `save` 后重开，从标准 comment 导入映射；GUI 的临时 checkbox 状态不存盘，因此重新打开默认 store=false。控制器硬件 identity 不写入 frozen comment。

### 数据注入

每次有效配置生成 `session.inputs` 的 data-only `gamepad-mapping` event，现有 device adapter 校验并在 frame 边界应用。

```json
{"frame":0,"device":"gamepad-mapping","data":{"index":0,"id":"controller-a","mapping":{"buttons":[{"type":"key","high":"z"}],"axes":[]}}}
```

同一控制器/帧的配置替换，不累积无限重复。实际按钮/axis 值仍由现有命令送入。

```sh
device gamepad '{"index":0,"id":"controller-a","buttons":[1,0],"axes":[0.8,0]}'
record start /absolute/new-pad-record --duration 1 --projectaudio false
```

真实 runner/record worker 使用 `createInputReplay`；没有私自执行 GUI userscript，也不在 mapping module 中直接注入 VM。只配置 metadata 不等于真实 OS 控制器测试。

## 验收边界

- `test/gamepad-mapping.test.js` 对比真实 frozen GamepadData/export 纯函数和 comment parser，测试 CommandSession store、dirty、controller switch、undo/redo、parser/save/reload 与实际 VM key/mouse replay。
- `test/recording.test.js` 分开列模拟项目帧/六选项边界、真实 native WAV 数值混音，以及真实系统 ffmpeg/ffprobe MP4/WebM 编码、读回帧数和非零 PCM/RMS。PNG 使用 header 和 decoded pixels 双验证；另测 exact grants、超时/dispose kill 和失败目录清理。
- **未验收**：真实 GUI MediaRecorder 差分、实时 OS 捕捉、完整项目 audio/music clockOffline scheduling、browser/turbo/interpolation 的完整时间等价。不得把这些缺口写成“已完成”。
