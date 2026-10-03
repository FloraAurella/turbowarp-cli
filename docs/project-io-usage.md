# 项目 I/O、冻结素材库与本地文件背包

所有常规命令默认无 DOM、禁止网络。需要 Node 24。本模块不读取 IndexedDB，也不更换既有 `open`/`save` 入口。

## 多格式项目与 sprite3

```text
new
project import /absolute/path/legacy.sb
project import /absolute/path/legacy.sb2
project import /absolute/path/project.sb3
project export /absolute/path/converted.sb3
project export --output /absolute/path/converted.sb3
project export-sprite --target Sprite1 --output /absolute/path/Sprite1.sprite3
project import-sprite /absolute/path/Sprite1.sprite3
save /absolute/path/working.sb3
```

`project import` 是编辑操作，不改变当前保存路径、不清空历史，必须已有项目（可先 `new`）。主命令层的 transaction 提供失败回滚、undo/redo；整个项目替换导入仍按编辑处理。导出文件仅用 positional 或 `--output`；不能同时指定两者。`--force` 仅允许覆盖普通文件，拒绝 symlink。不得把导出 `--output` 当成项目 `--out` 持久化。

SB/SB2 由冻结 scratch-parser/VM 转换为 SB3。SB 是真正 ScratchV01/02 二进制，经 VM 使用的冻结 scratch-sb1-converter 读取；SB2 ZIP 包支持一层目录。提前检查原始 ZIP 路径、200 MiB 展开限制、所有必须本地存在的资产；缺失不回退下载/默认素材。SB3 和 SB2 的文件资产校验 MD5，SB 二进制内部媒体由冻结 converter 转码后再校验保存资产。原始位图、SVG、WAV 字节在无需合并/转码时保持。SB PCM 转为 WAV，不能宣称源容器字节一致。

转换使用 renderer-free VM 避免浏览器对象。旧 SVG 的浏览器 `getBBox`、文字、Scratch 2 SVG quirks 归一化不宣称 GUI parity；CLI 保留原 SVG bytes，用原生 rasterizer hydrate。旧位图 text-layer 使用原生 canvas 合并，合并后的 PNG 字节有意改变。Legacy 可执行 ScratchX/未知扩展拒绝，转换后的 SB3 再次进行扩展、opcode、cloud 及资产校验。层序从 legacy executableTargets 保留，独立于角色列表 indexInLibrary；重复名称不用于层序匹配。

自有 `tw-cli-state.json` 保留目标 ID、监视器目标引用和每个 costume/sound 条目的稳定 `cliId`。资产 rename/reorder 不改变条目 ID；同 MD5 的不同条目有不同 ID；旧项目缺 metadata 时分配新 UUID。metadata.assets 为 target UUID → costumes/sounds UUID 数组，数量、目标键、全局唯一性必须匹配。metadata.extra.loadedExtensions 保存批准且已加载的内置扩展，不改变官方 JSON 的 unused-extension 序列化语义。

## 冻结 GUI 素材浏览与加载

```text
library categories sprite
library list costume --category animals --offset 0 --limit 30
library search sprite cat --category animals
library search sound pop
library list backdrop --category outdoors
library status
library load sprite Abby
library load costume Abby-a --target Sprite1
library load sound Meow --target Sprite1
library load backdrop Arctic
```

类别、搜索词和名称来自冻结 GUI JSON，JSON 哈希及素材 manifest 哈希均核对。名称大小写不敏感，可使用稳定的 JSON 下标；重名/歧义拒绝。backdrop 加到 stage；其他单资产用当前或 `--target` 角色。加载是编辑操作，交给主层 transaction；一次性命令可用 `library load sprite 'Cat 2' --project input.sb3 --out result.sb3` 保存。项目 import/import-sprite、backpack load 和 restore 同样支持 `--out result.sb3`，不与只读导出 `--output` 混淆。全条目的 asset bytes 先读齐校验，sprite 加载不会边读边留下半个角色。

可独立分发资源优先：当 `tw-cli/resources/library-manifest.json` 与 `resources/libraries/sprites.json` 同时存在，四个GUIJSON由 `resources/libraries/` 读取、素材默认 `resources/library/<md5>.<ext>.br`，仍校验完全相同的冻结hash。源码开发布局缺这些资源时回退 `desktop-master/scripts/library-files.json`、冻结GUI JSON与 `desktop-master/dist-library-files/<md5>.<ext>.br`。可 `--dir /explicit/cache`。Brotli 解压限制 32 MiB，必须同时匹配冻结 md5/sha256。缺素材异常包含完整路径和显式 fetch 命令；没有隐式网络。

## 显式、有限下载和真实回收

从 `tw-cli` 目录使用 Node 24 运行：

```sh
node scripts/fetch-cli-library.js --kind sprite --name Abby --timeout-ms 4000 --retries 1 --budget-ms 90000
node scripts/fetch-cli-library.js --asset 83a9787d4cb6f3b7632b4ddfebf74367.wav --dir /absolute/cache
node scripts/fetch-cli-library.js --limit 1304 --concurrency 4 --budget-ms 90000
node scripts/fetch-cli-library.js --local-archive /absolute/genuine-project.sb2
node scripts/fetch-cli-library.js --desktop-release 1.16.0 --budget-ms 150000
node scripts/fetch-cli-library.js --desktop-release 1.16.0 --release-archive /absolute/official-release.tar.gz --budget-ms 90000
```

常规下载仅 `assets.scratch.mit.edu`、`cdn.assets.scratch.mit.edu` 的 HTTPS；不跟随未知 redirect。请求 0.1–30 秒，重试轮次 1–3，并发 1–8，总预算最长 540 秒。32 MiB 单资产限额；hash 不匹配不写入；已有无效或 symlink 文件不覆盖，报告错误。输出区分 downloaded、alreadyVerified、failed、skippedByBudget 和总体 missing。

`--local-archive` 只扫描显式 ZIP 内真实字节，并按 manifest 两个 hash 回收，计为 recoveredLocal，不冒称下载。`--desktop-release` 显式访问官方 TurboWarp/desktop 的数字版本 Linux tar.gz，HEAD 确认 ≤200 MiB，有限下载到私有临时目录，只流式提取唯一 `resources/app.asar`，用现有 desktop ASAR reader 只读 `dist-library-files`。不运行或解包其他二进制、不挂载 DMG、结束清理缓存。逐条 Brotli 解压和冻结双 hash 校验，计为 recoveredRelease；release 内未知/不同 hash 素材不能代替冻结素材。

## 显式 URL 获取（不隐式打开）

```text
project fetch https://example.org/local-project.sb3 /absolute/result.sb3 --allow net:example.org --max-bytes 104857600 --timeout-ms 15000
project import /absolute/result.sb3
```

fetch 不需当前项目，不修改编辑状态；复用共享 permission-policy + network-policy.fetchBytes。默认 deny，每个 redirect 主机都独立授权，不允许 HTTPS 降级；项目 URL 只允许 HTTPS。输入总大小最多100 MiB、总超时0.1–30秒，获取后先冻结parser/VM+资产安全校验，再原子写SB3。`--allow` 只在该条命令生效，写文件路径是显式授权，不能通过网络授权获得任意扩展执行。Scratch ID/token 云拉取及远程散装资产组装不包含在此接口；不声明真实Scratch服务器验收。loopback测试只验证共享HTTP权限/redirect/maxBytes边界。

## 原子本地文件背包

```text
backpack use /absolute/backpack-dir
backpack list
backpack save project "Project snapshot"
backpack save sprite "My sprite" --target Sprite1
backpack save block "Movement stack" BLOCK_ID --target Sprite1
backpack save costume "Costume copy" COSTUME_NAME_OR_INDEX_OR_CLI_ID --target Sprite1
backpack save sound "Sound copy" SOUND_NAME_OR_INDEX_OR_CLI_ID --target Sprite1
backpack load ITEM_UUID --target Sprite1
```

显式目录不使用任何 IndexedDB。每个 `<UUID>.backpack.zip` 同时含 item.json 与 payload，先 fsync 临时文件再原子发布，不依赖易损外部 index。列表/加载检查普通文件、路径、展开大小、UUID 及 payload sha256。项目条目恢复整个项目和 selected ID，sprite 走 sprite3，单资产保存真实字节及标准描述；block 保存闭合 stack graph 与必要变量描述，导入重新分配块 ID/修复变量引用。store use/list/save 不改变 VM；load 是编辑，由主层 transaction 回滚。物理文件保存不进编辑 undo，重复 save 产生新 UUID。

## Restore points

```text
project restore-use /absolute/restore-dir
project restore-save "Before experiment"
project restore-list
project restore POINT_UUID
```

restore-save 保存完整 SB3 和选择 ID，保留稳定目标/资产 ID 与 monitor 指向。restore 是普通编辑，可以 undo；不自动读写保存路径。可在 list/save/restore 上用 `--dir` 选择显式目录；use 路径仅会话内记录，跨进程重新 use。

## 主代理集成契约

`src/project-io-commands.js` 导出 `{specs, requiresProject, isReadOnly, execute, booleanOptions}`，三顶层 command 为 library/backpack/project。spec min/max 不含子命令，args **包含**子命令。仅 force 为 boolean；output/dir/query/category/offset/limit/target/project 是 value option。

router 必须先做 spec/option 校验、处理可选 `--project`，随后 requiresProject，最后 `isReadOnly ? execute : session.transaction(label, execute)`。模块不嵌套 transaction、不改 session.dirty/undo/redo。import/restore/import-sprite/library load/backpack load 为编辑；其他操作只读 VM（允许显式本地文件 side effect）。`--output` 文件写入由模块负责，绝不把它传作 transaction 的 `options.out`。如果主层 onTarget 包裹 `--target`，文件/全项目恢复后旧 target 不再存在，应沿用已有保护逻辑。

`Project.ensureAssetIds(target)` 可供资产模块列举/create 后调用；`Project.load` 独占整合所有 metadata 和安全策略。目前精确内置白名单为 pen/music/videoSensing/Gamepad；后两者必须由 `device-adapters.registerOfflineExtensions(vm)` 在 load 前注册安全离线 factory（无摄像头自动采集、无 timer/DOM、实时 loudness=-1、ScratchLink deny），dispose 在 VM clear 前释放。已验证双 reload 的真实 reporter project；这不授予真实设备连接，也不允许未知 extensionURL。继续扩大白名单仍必须新增安全 provider/hook 与真实 fixture。

## 验收范围

`node --test test/project-io.test.js` 包含真正二进制 SB、冻结 parser 的真实 SB2/nested/SB3 文件、资产 bytes、层序、sprite3、缺素材/坏 hash、目录/symlink/traversal、5 类背包跨会话重载、恢复 monitor/稳定条目 IDs。图像 SVG quirks、原图库全部素材、包内脚本浏览器播放不因容器可读就称 parity；每次实际 fetch 数以脚本输出为准。

本轮实际验收使用 Node 24.18.0：project-io 最终18/18（resources模式）、此前project-io+device 29/29、全部仓库189/189（均无skip），check-baseline complete=true。独立resources/library也实读1304/1304双hash通过，无invalid。MIT直连90秒预算请求92次，下载0；本地真实SB2回收3；官方GitHub v1.16.0 Linux archive真实下载159,568,466 bytes，app.asar回收1301条。最终dist素材1304/1304双hash验证、缺失0、invalid0；临时发布包已删除，baseline.json未改。已实跑Abby/Abby-a/Meow/Arctic四类素材加载+asset bytes+reopen。
