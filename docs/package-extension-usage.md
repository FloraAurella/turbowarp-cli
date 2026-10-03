# 打包、扩展与统一权限

适用冻结版本：`@turbowarp/packager 3.13.0`、Node.js **24.x**。本模块只生成文件，不打开浏览器、Electron 或 NW.js，也不表示全部平台和设备都已运行验收。

## 快速开始

在 `tw-cli` 目录执行 `./tw`。一次性命令的配置不会自动存到下次进程；连续配置请用 `./tw session`，或者先导出 JSON，再在会话中导入。

```text
./tw session
open 我的项目.sb3
pack set app.windowTitle 我的游戏
pack set framerate 60
pack set controls.pause.enabled true
pack build 游戏.html
pack build 网站.zip --target zip
pack build 单资产.zip --target zip-one-asset
pack export 打包配置.json
quit
```

`pack build` 只读项目，不把项目标脏。包产物和配置导出采用**位置参数或 `--output`**，不能同时指定。`--out` 仍保留给项目修改/保存，不能拿它当包输出路径。

```text
./tw pack build 游戏.html --project 我的项目.sb3
./tw pack build --project 我的项目.sb3 --output 网站.zip --target zip
./tw pack build 游戏.html --project 我的项目.sb3 --opt autoplay=true
./tw pack preview 预览.html --project 我的项目.sb3
```

`preview` 的含义是写 HTML 文件，不执行页面或启动窗口。HTML 可以离线单文件使用；`zip`/`zip-one-asset` 是网站 ZIP，需要自行部署到静态 HTTP 服务。ZIP 内页面使用相对地址读取资产，不表示有外部联网。

## 全部选项，严格类型

```text
pack inspect
pack inspect cloudVariables
pack get controls.pause.enabled
pack set turbo true
pack set stageWidth 640
pack config '{"stageWidth":640,"stageHeight":360,"app":{"windowTitle":"中文标题"}}'
pack reset controls
pack reset
pack import 打包配置.json
pack export --output 打包配置.json
```

- 会话配置存在 `session.packagerSettings`。不改项目内容、不保存授权、不隐式读用户配置目录。
- 支持全部 **58 个默认叶选项**、全部默认嵌套分组。M1 账本中的 58 个 `package.option.*` 均有对应路径。
- `set` 的布尔/数字/对象/数组使用 JSON 类型；`false` 不等于字符串 `"false"`，数字不接受字符串或 NaN/Infinity。字符串可以用普通 CLI 文本；要保留 JSON 字符串语义则传 JSON 引号。
- `config`、`import` 接受完整或部分嵌套 `PackagerOptions` JSON，与当前设置合并；缺省字段保留，数组整体替换，不进行猜测式版本迁移。
- 未知字段、错误枚举、错误类型、getter/setter、非普通 JSON 对象，以及 `__proto__`/`prototype`/`constructor` 一律拒绝。整次配置校验或授权失败时不改变旧配置。
- `reset [分组或叶路径]` 恢复 CLI 安全默认，不重新授权剩余敏感字段。上游原始默认值也可在 `inspect` 查询。
- `pack reset-group runtime|appearance|input|cloud|advanced|target|app|steamworks` 精确覆盖冻结 GUI 的八个局部重置按钮，不错误重置其他字段。`inspect.resetGroups` 返回实际字段清单；appearance 同时清 icon/loading 图片，input 同时清光标图片。GUI app 局部重置不会重置 version/windowControls，CLI也保留它们。

完整路径如下。

| 分组 | 叶选项 |
| --- | --- |
| 顶层 | `turbo`, `interpolation`, `framerate`, `highQualityPen`, `maxClones`, `fencing`, `miscLimits`, `stageWidth`, `stageHeight`, `resizeMode`, `autoplay`, `username`, `closeWhenStopped`, `projectId`, `packagedRuntime`, `target`, `extensions`, `bakeExtensions`, `maxTextureDimension` |
| `custom` | `css`, `js` |
| `appearance` | `background`, `foreground`, `accent` |
| `loadingScreen` | `progressBar`, `text`, `imageMode`, `image` |
| `controls` | `greenFlag.enabled`, `stopAll.enabled`, `fullscreen.enabled`, `pause.enabled` |
| `monitors` | `editableLists`, `variableColor`, `listColor` |
| `compiler` | `enabled`, `warpTimer` |
| `app` | `icon`, `packageName`, `windowTitle`, `windowMode`, `version`, `escapeBehavior`, `windowControls`, `backgroundThrottling` |
| `chunks` | `gamepad`, `pointerlock` |
| `cloudVariables` | `mode`, `cloudHost`, `custom`, `specialCloudBehaviors`, `unsafeCloudBehaviors` |
| `cursor` | `type`, `custom`, `center.x`, `center.y` |
| `steamworks` | `appId`, `onError` |

主要约束。

- `resizeMode`：`preserve-ratio` / `stretch` / `dynamic-resize`。
- `loadingScreen.imageMode`：`normal` / `stretch`。
- `app.windowMode`：`window` / `maximize` / `fullscreen`。
- `app.escapeBehavior`：`unfullscreen-only` / `exit-only` / `unfullscreen-or-exit` / `nothing`。
- `app.windowControls`：`default` / `frameless`；`steamworks.onError`：`ignore` / `warning` / `error`。
- `cloudVariables.mode`：`ws` / `local` / `none` / `custom`；`custom` 对象为云变量名→`ws`/`local`/`none`。
- `cursor.type`：标准 CSS 光标枚举或 `custom`，不能注入 CSS URL。
- `framerate`：1..1000 有限数字；`maxClones`：0..9999999999 整数（上游无限克隆值为 9999999999）。
- 舞台宽高：1..8192 整数，总计不超过 1600 万像素；`maxTextureDimension`：1..16384 整数；光标热点：0..8192 整数。
- 所有颜色为 `#rrggbb`。`app.packageName` 是最多 100 字符的安全 ASCII 单段名称，不接受目录、Windows 保留名；版本为 `1.2.3` 等三段版本号。
- 自定义 JS/CSS 不允许 `</script>`/`</style>` 等 HTML 结束标签注入。此限制不是 JS/CSS 沙箱。

## D3 云变量：默认本地

上游默认 `mode=ws` 并连接公共云服务器。CLI 安全默认改成 **`mode=local`、`cloudHost=""`**，写入打包产物的 localStorage 提供器；也可使用 `none`。这不复制桌面本地云 JSON 文件，也不把本地云偷偷改成网络云。

```text
pack set cloudVariables.mode none
pack config '{"cloudVariables":{"mode":"custom","custom":{"☁ 分数":"local","☁ 临时":"none"}}}'
```

联网云必须在**配置时和打包时分别**显式授权云能力及每个主机。

```text
pack config '{"cloudVariables":{"mode":"ws","cloudHost":"wss://cloud.example.org"}}' --allow cloud-network,net:cloud.example.org
pack build 联网游戏.html --allow cloud-network,net:cloud.example.org
```

`wss://clouddata.turbowarp.org` 上游会自动加入 `.xyz` 备用地址，所以必须同时授权 `net:clouddata.turbowarp.org,net:clouddata.turbowarp.xyz`。`cloudVariables.unsafeCloudBehaviors=true` 必须独立 `--allow unsafe-cloud`，不能仅靠云联网许可通过；此能力可在产物运行时打开外链/下载，应只对信任项目启用。

## 图片：icon、cursor、loadingScreen

三类图片都只接受 `null` 或 `{"file":"本地路径"}`；`pack set` 可直接传本地文件路径。不接受 URL、`data:`、任意 MIME/buffer 对象或原型实例。

```text
pack set app.icon /绝对路径/icon.png
pack set cursor.custom /绝对路径/cursor.png
pack set cursor.type custom
pack set cursor.center.x 4
pack cursor-center --allow read:/绝对路径/cursor.png
pack set loadingScreen.image /绝对路径/loading.svg
pack build 游戏.html --allow 'read:/绝对路径/icon.png,read:/绝对路径/cursor.png,read:/绝对路径/loading.svg'
```

图片配置中的文件是**间接路径**，包括从 JSON 导入的文件，因此 build 需要精确 `read:`，不因曾经设置路径就永久授权。读取限制 16MiB / 1600万像素，验证文件真实格式再解码重编码成 PNG，全部通过 `new Packager.Image('image/png', bytes)` 交给上游。支持 PNG/JPEG/GIF；SVG仅支持有宽高的安全几何子集，无脚本、事件、DTD/实体、外部引用、CSS、字体或嵌套图片。不支持的 SVG 明确拒绝。

拒绝 `..`、URL/Windows路径/编码 traversal、控制字符以及所有符号链接路径组件。macOS `/tmp`、`/var` 常是系统符号链接，建议先 `realpath`，使用 `/private/tmp/...` 等规范路径。这是防止静态路径逃逸，不是对恶意并发本地文件系统修改的 OS 沙箱承诺。

## 敏感代码和能力

能力独立，不允许一个笼统 `unsafe-options` 许可覆盖全部。

| 配置 | 本条命令所需 `--allow` |
| --- | --- |
| 非空 `custom.js` | `custom-js` |
| 非空 `custom.css` | `custom-css` |
| `extensions` HTTPS URL数组 | `extension-code` + 每个 URL 的 `net:host` |
| 联网 `cloudHost` 或 `mode=ws` | `cloud-network` + 每个云主机的 `net:host` |
| `unsafeCloudBehaviors=true` | `unsafe-cloud` |
| `chunks.gamepad=true` | `gamepad`（输出功能，不代表设备已验证） |
| `chunks.pointerlock=true` | `pointerlock`（输出功能，不代表交互已验证） |

配置、导入和 build 都重新检查敏感设置。`custom.js/css` 和扩展代码只写入产物，**不会在 CLI 中执行**。允许写入并不证明代码安全、也不限制将来浏览器执行时的能力或联网地址。Packager 产物上游 CSP 明确不提供恶意代码沙箱，不应把本模块的打包授权当部署沙箱。

`bakeExtensions=true` 时先做受控下载并嵌入代码；下载失败直接失败，不采用上游“失败后仍保留远程 URL”的降级。`false` 会保留显式授权的远程地址，产物就不是纯离线包。当前不执行自定义文件/文本/URL扩展；`extension-code` 仅用于打包包含，不是运行授权。

## 全部官方 targets 与目录缓存

```text
pack targets
pack download webview-mac --cache /绝对路径/cache --allow net:packagerdata.turbowarp.org
pack set target electron-win64
pack build Windows游戏.zip --cache /绝对路径/cache --allow net:packagerdata.turbowarp.org
```

离线目标：`html`、`zip`、`zip-one-asset`。

需官方下载资产的目标：

- `nwjs-win32`、`nwjs-win64`、`nwjs-mac`、`nwjs-linux-x64`。
- `electron-win32`、`electron-win64`、`electron-win-arm`、`electron-mac`、`electron-linux64`、`electron-linux-arm32`、`electron-linux-arm64`。
- `webview-mac`。

官方下载必须同时显式 `--cache 目录` 和 `--allow net:packagerdata.turbowarp.org` 或 `net:blobs.turbowarp.xyz`。两个 host 分别授权，默认不自动打开备用镜像。即便 cache 已命中仍要求本条命令授权，保持目标下载接口一致。固定版本资产名/URL/SHA-256 由源码 pin，缓存为 `目录/<sha256>.zip`。不使用上游隐式 `node_modules/.packager-cache`。

每次命中仍比较 SHA-256，验证 ZIP 条目、展开上限和相对 symlink（只保留在 ZIP 中，不解包不跟随）。投毒缓存不会使用，也不会自动覆盖。重定向的每个新 host 要先授权，禁止 HTTPS 降级，下载有超时/字节限制，无进程级全局放开网络窗口。

macOS 使用无 DOM 的本地 PNG→ICNS、plist 解析和安全 XML 转义；仅为完整目标生成文件提供适配，不启动 `.app` 或 `electron`，不等于 macOS/Windows/Linux 实机都验收。Steamworks 选项可配置，但当前项目安全门不执行 Steamworks 自定义扩展；因此不能把选项覆盖声明成 Steamworks 实际运行完成。

## 扩展目录、文档和内置加载

```text
ext list builtin
ext list offline
ext list gallery
ext inspect box2d
ext doc box2d 文档.txt
ext load pen
ext load music
ext list loaded
save 内置扩展项目.sb3
```

- `builtin` 显式枚举冻结 GUI 全部 13 个入口：pen/music/videoSensing/faceSensing/text2speech/translate/makeymakey/microbit/ev3/boost/wedo2/gdxfor/tw，另加CLI安全数据 `Gamepad`；各有具体支持状态、source、vmBuiltin 和原因。faceSensing 是画廊提供，不假称此冻结 VM 自带。videoSensing/Gamepad 当前实现 source=`cli-data-adapter`，不是执行任意画廊代码。
- `offline`、`gallery` 都是 **103 项冻结离线画廊**，优先读取CLI随附 `resources/extensions`，开发快照缺资源时才回退桌面冻结目录；逐文件比较 baseline SHA-256，不刷新远程目录；存在字节不表示可以执行。
- 文档把冻结离线 HTML 转成纯文本，去除 script/style/iframe 等节点和终端控制字符；无浏览器窗口、DOM执行、外部请求。无本地文档时只输出状态与安全 URL。写出文件需显式路径，不自动打开链接。
- `pen`、`music` 真实加载冻结 VM 内置积木。仅加载无积木的状态通过 Project 已校验 `tw-cli-state.json` 的 `extra.loadedExtensions` 保存，撤销/重做与重开可保留。含音乐积木的包采用上游 `usesMusic` 的完整本地音乐运行库。
- `ext load videoSensing` / `ext load Gamepad` 真正加载已注册的安全数据factory，可经保存/重开/撤销/重做保留。前者使用预录PNG/JPEG帧和冻结motion算法，后者使用按钮/轴记录数据reporter，真实摄像头/手柄振动仍拒绝。数据注入由 `device` 模块负责，权限枚举不等于实时设备实现。
- **含 videoSensing/Gamepad 积木的项目目前不能 pack build**：返回 `missing-data-provider-conversion`。CLI预录provider不能默默变成产物实时相机，CLI Gamepad自有积木不能生成缺opcode的伪成功产物。这是未完成的产品转换能力，不是 N/A。仅加载但无引用积木的元数据不改变上游核心产物。
- 其他入口目前均明确未支持，绝不返回假 `loaded:true`。麦克风、实时摄像头、BLE/Scratch Link/USB/固件等没有设备实测；CLI音乐采样音色对拍也不在此验收中。
- `ext load-file` / `load-text` / `load-url` 明确 `ERR_CAPABILITY_UNSUPPORTED`，即使 `--allow extension-code,extension-execute` 也不会读取、下载或执行源码。原因是尚无经过验证的**独立受限子进程**执行边界。`node:vm`/VM 或不给出 require 的进程内上下文不是恶意 JS 沙箱；这里没有以伪沙箱降格为通过。

## D5 权限检查与拒绝日志

```text
permission list
permission inspect
permission check net:example.org
permission check net:example.org --allow net:example.org
permission check clipboard-read --allow clipboard-read
permission log
```

- `read:/精确文件`、`write:/精确文件` 分开。直接命令输入/输出路径只授权**本条命令此文件**，不授权父目录、同级文件或后续命令。`--cache` 只授权固定 SHA-256 文件。
- `net:host` 精确匹配，不含子域、端口通配、凭据、`*.example.org`、缩写 IP。多许可用**一个**逗号列表或 JSON 字符串数组；不重复 `--allow`。
- `extension-code`、`custom-js/css`、`cloud-network`、`unsafe-cloud`、`builtin-extension:pen/music/videoSensing/Gamepad`、gamepad/pointerlock 独立。
- clipboard-read/write、audio-input、video-input、bluetooth、usb、serial、notifications、location、open-window、redirect、embed、extension-execute 枚举清楚，但当前未实现时即使有 allow 仍拒绝，不把授权决定当功能完成。
- 会话保存最近 1000 条决定，每条有 capability/resource/allowed/**reason**。被截断记录的数量在 `dropped` 返回；不导出到打包设置文件。`permission inspect` 明确 VM 不是安全沙箱。
- 网络底线始终默认拒绝 TCP、UDP 和全局 fetch；受控下载仅用私有单次 agent，检查完成后仍不会恢复全局网络。

## 验收范围

新增验收用 Node24 运行。

```text
node --test test/package-options.test.js test/extension-policy.test.js
node --test test/m2-packager.test.js test/security.test.js
```

测试包括完整选项路径覆盖、嵌套配置与原子失败、权限/恶意路径/缓存投毒拒绝、三种真实离线产物、HTML嵌入SB3还原、脚本只解析不执行、所有资产字节与MD5/SHA-256、图片真实格式、安全文档、pen/music加载与持久化、逐重定向host授权及默认网络deny保持。

官方下载目标的许可与缓存门有逐target拒绝测试；本地 Electron 组装fixture仅验证文件结构和脚本解析，不是官方下载/实机运行证据。未下载或未实际启动的目标、三平台、硬件、浏览器播放、云服务连接、任意扩展沙箱都不能宣称全通过。具体本次命令与结果由完工报告给出，M1 census 原始状态不在本模块擅自升级。

本次另做一次真实官方下载验收：`pack download webview-mac --cache /private/tmp/tw-official-webview-QJBmNj/cache --allow net:packagerdata.turbowarp.org`，下载的 3,530,149 字节匹配固定 SHA-256 `fef0603a17df6dd976eb2aeb704aaec6d2666455089fbf3398becfaf5b29448b`；随后相同许可/cache 的 `pack build --target webview-mac` 命中缓存，验证实际 ZIP 的 plist、ICNS、脚本语法和两个项目资产字节。仅此官方 target 有本次真实下载/封装证据；未启动应用，不能据此宣称其他targets或三平台播放完成。
