# M4 原生绘图、声音与资产指令

本页只描述已实现的数值化动作和验收边界，不把 census 的处置提案视为 GUI 对等验收。实现不使用 DOM、浏览器、Electron、系统剪贴板或真实扬声器；保留旧 `vector`、`bitmap`、`sound` 编辑入口。新模块导出 `specs`、`requiresProject`、`isReadOnly`、`execute`，由主命令路由提供 `session.transaction`，不嵌套项目事务。

## 通用约定

- 在 `tw session` / JSONL 中连续执行。一次性编辑用 `--project input.sb3 --out result.sb3`，连续编辑后用 `save result.sb3`。
- `--target <目标 UUID 或名字>` 默认当前目标。显式编辑其他目标后恢复原编辑目标。
- `asset list costume` / `asset list sound` 返回持久 UUID `id`，与内容 MD5 `assetId` 分离。重命名、重排、改像素/波形、SB3 重载及 undo/redo 保持条目 UUID；duplicate/share/copy-to-new 生成新 UUID，即使资产字节完全相同。UUID 持久化由 `Project.ensureAssetIds` / SB3 `tw-cli-state.json` 的 `assets` 字段提供。
- 兼容名字和 **0-based** 资源索引。内容 hash 只在唯一时可作选择器；两个字节相同的副本需用条目 UUID。
- 造型的 SVG 坐标是 SVG 本地单位，位图坐标和中心是**资产像素**。位图 `bitmapResolution=2` 时每两个资产像素对应一舞台单位。几何与颜色参数只接受有限数字；图片最多 1600 万像素。
- 文件导出用 `--output file` 或位置参数，**不使用项目 `--out` 作为剪贴板或媒体路径**。默认拒绝覆盖，明确 `--force` 才覆盖。
- 所有显式配置/SVG/剪贴输入通过共享 `project.js` 导出的 `readLocalFile` 的 descriptor + `O_NOFOLLOW` 读取，不先 stat 后普通 read。配置最多4 MiB、SVG/矢量 JSON 剪贴最多16 MiB、PNG/WAV最多32 MiB；叶/父符号链接由共享文件策略拒绝（macOS系统路径别名按共享策略例外）。所有输出继续共用 `atomicWrite`，拒绝用户父路径符号链接，不能用 `--force` 绕过。
- 复制文件是当时选区的快照，之后修改源资源不会改变快照。矢量 JSON、位图 PNG、声音 WAV 均可跨造型/目标使用。系统剪贴板从不读写。
- `paint select` / `asset range sound` 是显式选择描述，不创建隐藏 GUI 选区；后续命令重复传 `--nodes` / `--rect` / `--range`。声音 `asset select sound` 不修改项目或暗存 GUI 播放状态。
- mutating execute 必须通过命令路由或由调用者包进 `session.transaction`。直接调用模块 execute 不额外承诺事务。

## 矢量绘图

### 新建、节点与多选

```text
asset blank costume drawing --mode vector --width 100 --height 80
asset list costume
paint nodes <costume-id>
paint select <costume-id> --nodes node-a,node-b
paint rectangle <costume-id> --spec '{"x":2,"y":3,"width":20,"height":10,"fill":"#ff0000"}'
paint ellipse <costume-id> --spec '{"cx":50,"cy":30,"rx":12,"ry":8,"fill":"#0000ff"}'
paint line <costume-id> --spec '{"x1":0,"y1":0,"x2":40,"y2":20,"width":3,"stroke":"#000000"}'
paint brush <costume-id> --spec '{"points":[[5,5],[10,8],[20,20]],"width":6,"color":"#00ff00"}'
paint path <costume-id> --spec '{"d":"M0 0 C0 30 40 30 40 0 L60 0","fill":"none","stroke":"#000000"}'
paint text <costume-id> --spec '{"x":5,"y":25,"text":"Hello","fontSize":20,"font":"sans-serif"}'
paint text-set <costume-id> 'New text' --nodes <text-id>
```

每个 SVG 节点有 `id`；已有无 ID 的节点按文档顺序生成不冲突的 `node-N`，首次修改时写入 XML。`paint nodes` 返回节点/父节点 ID、属性和已应用父/节点 transform 的几何包围盒。选父组和其子节点时去掉重复子选择，避免变换两次；`--nodes all` 选根绘图项，`delete` / `clear` / 无选择 flip 默认整图。

```text
paint copy <costume-id> --nodes node-a,node-b --output clip.json
paint cut <costume-id> --nodes node-a,node-b --output cut.json
paint paste <costume-id> --from clip.json --dx 10 --dy 5
paint clone <costume-id> --nodes node-a,node-b --dx 15 --dy 0
paint group <costume-id> --nodes node-a,node-b
paint ungroup <costume-id> --nodes <group-id>
paint order <costume-id> front --nodes node-a,node-b
paint order <costume-id> backward --nodes node-a,node-b
paint delete <costume-id> --nodes node-a,node-b
paint clear <costume-id>
```

复制保留世界坐标、继承的 presentation 样式和 defs；粘贴重分配节点/segment/gradient ID 并改写本地引用。group 需两个以上同父节点，保留选择内层序；order 支持 `front/back/forward/backward`，以同级绘图节点为层，不把 XML 空白当一层。Ungroup 合成 opacity≠1 或 clip/mask/filter 的组会明确拒绝，以免视觉改变。Cut 先原子写出快照再删；为了避免两文件提交的部分成功，**cut 不允许同时 `--out`**，需另外 save。输出文件不会被项目 undo 删除。

### 几何变换与路径点

```text
paint align <costume-id> left --nodes node-a,node-b
paint align <costume-id> center-y --nodes node-a,node-b
paint distribute <costume-id> horizontal --nodes node-a,node-b,node-c
paint transform <costume-id> --nodes node-a,node-b --spec '{"dx":10,"dy":5,"scaleX":2,"scaleY":1,"rotate":30,"skewX":10,"pivot":[0,0]}'
paint transform <costume-id> --nodes node-a --spec '{"matrix":[1,0,0.2,1,5,6]}'
paint rotate <costume-id> 90 --nodes node-a
paint scale <costume-id> 2 3 --nodes node-a
paint skew <costume-id> 15 0 --nodes node-a
paint flip-x <costume-id> --nodes node-a,node-b
paint points <costume-id> --path <path-id>
paint point-add <costume-id> --path <path-id> --after <segment-id> --t 0.5
paint point-set <costume-id> --path <path-id> --segments <segment-id> --spec '{"x":25,"y":20,"handleIn":[-5,-2],"handleOut":[5,2]}'
paint pointed <costume-id> --path <path-id> --segments segment-a,segment-b
paint curved <costume-id> --path <path-id> --segments <segment-id>
paint point-delete <costume-id> --path <path-id> --segments <segment-id>
paint point-delete <costume-id> --path <path-id> --segments <segment-id> --spec '{"adjustNeighbors":true}'
```

Align 支持 left/right/top/bottom/center-x/center-y；distribute 为首尾范围内均匀**间距**，>=3 节点。默认旋转、缩放、倾斜、翻转 pivot 是选区联合包围盒中心；显式 matrix 按世界坐标左乘，正确换回带 transform 的父坐标。路径支持 M/L/H/V/C/S/Q/T/A/Z 和相对形式；转换为 cubic segment 结构，ID 写在 `data-tw-segments`，分割使用 de Casteljau 保留 cubic 几何，弧线编辑转换为 <=90° cubic 近似。

`point-delete` 默认与冻结 `selection.js` Delete 的 `seg.remove()` 一致，保留邻段 handle；`adjustNeighbors:true` 对应 `point-tool.js removePoint` 双击删点，按新的曲线长度 × `HANDLE_RATIO=0.3902628565` 调整邻 handle 长度，端点 handle 清零。曲线长度为原生数值积分，不冒称 Paper 积分逐位一致。Curved 用相同 HANDLE_RATIO、对齐相反方向 handle；直线内点行为已数值测试，带原有弯曲的端点法线和 Paper 非直线曲率细节仍是 limited。

### 颜色、描边、透明度和渐变

```text
paint style <costume-id> --nodes node-a,node-b --fill '#ff0000' --stroke '#000000' --stroke-width 2 --alpha 0.6
paint style <costume-id> --nodes node-a --fill-alpha 0.5 --stroke-alpha 0.8
paint style <costume-id> --nodes node-a --fill none
paint style <costume-id> --nodes node-a --hue 33.333 --saturation 100 --brightness 80
paint style <costume-id> --nodes node-a --gradient '{"type":"horizontal","stops":[{"offset":0,"color":"#ff0000"},{"offset":1,"color":"#0000ff","alpha":0.5}]}'
paint style <costume-id> --nodes node-a --property stroke --gradient '{"type":"radial","stops":[{"offset":0,"color":"white"},{"offset":1,"color":"black"}]}'
paint gradient-swap <costume-id> --nodes node-a
paint eyedropper <costume-id> 5 5 --nodes node-b --property fill
paint text-style <costume-id> --nodes <text-id> --font sans-serif --font-size 20 --font-weight bold --text-anchor middle
paint erase <costume-id> --nodes node-a --spec '{"points":[[20,0],[20,40]],"width":8}'
```

颜色支持 hex/命名/rgb/rgba/hsl/hsla/none；alpha 用 0..1，HSV 值用 0..100。渐变支持 horizontal/vertical/radial，2..128 个有序 offset=0..1 的 stops。新建/交换渐变不会改变其他共享原渐变节点。样式操作清除冲突的 inline style 对应属性，不会出现改属性但实际颜色不动的假成功。Eyedropper 对安全 native 渲染结果取 viewport 像素并实际落到所选节点 fill/stroke；无选择的取色使用 bitmap `sample` / 显式 draw 参数和 defaults 文件，不维护隐藏 UI 默认颜色。

Vector eraser 使用现有 native Path2D `Difference` 布尔几何；仅支持无 stroke 的填充形状/路径，遇到描边、text/image/use 明确拒绝。brush 是沿离散轨迹的 round-cap stroked outline，并非 GUI Paper blob 平滑/压力算法对等。

## 位图编辑

```text
asset blank costume pixels --mode bitmap --width 64 --height 48 --resolution 2
paint select <costume-id> --rect 2,3,20,10
paint rectangle <costume-id> --spec '{"x":2,"y":3,"width":20,"height":10,"color":"#ff0000"}'
paint rectangle <costume-id> --outlined --spec '{"x":2,"y":3,"width":20,"height":10,"thickness":2,"color":"#000000"}'
paint ellipse <costume-id> --spec '{"x":30,"y":5,"width":15,"height":10,"color":"#0000ff"}'
paint line <costume-id> --spec '{"x1":2,"y1":20,"x2":35,"y2":20,"width":3,"color":"#00ff00"}'
paint brush <costume-id> --spec '{"points":[[20,20],[30,20],[30,26]],"size":4,"color":"#ff0000"}'
paint erase <costume-id> --spec '{"points":[[25,18],[25,24]],"size":4}'
paint text <costume-id> --spec '{"x":5,"y":35,"text":"Hi","fontSize":16,"font":"sans-serif","color":"#ffffff"}'
paint flood <costume-id> --spec '{"x":5,"y":5,"color":"#ffff00","tolerance":0}'
paint fill-all <costume-id> --rect 0,0,10,10 --spec '{"color":"#abcdef","alpha":0.5}'
paint sample <costume-id> 5 5
paint copy <costume-id> --rect 2,3,20,10 --output selection.png
paint cut <costume-id> --rect 2,3,20,10 --output selection.png
paint paste <costume-id> --from selection.png --spec '{"x":30,"y":15,"alpha":0.5}'
paint crop <costume-id> --rect 2,3,20,10
paint move <costume-id> --rect 2,3,20,10 --dx 10 --dy 5
paint resize <costume-id> 128 96
paint scale <costume-id> 2 2 --rect 2,3,20,10
paint rotate <costume-id> 90
paint transform <costume-id> --rect 2,3,20,10 --spec '{"rotate":30,"scaleX":1.5,"pivot":[12,8]}'
paint flip-x <costume-id>
paint flip-y <costume-id>
paint replace-color <costume-id> --spec '{"from":"#ff0000","to":"#0000ff","tolerance":0}'
paint opacity <costume-id> --rect 2,3,20,10 --alpha 0.5
```

- Rect 必须是图内正整数像素。区域 copy 用 ImageData 精确保留；paste 接 PNG 快照（最多 32 MiB）再原生合成。不会给 URL/string 隐式联网。
- flood 为 4-connected 区域，以种子旧 RGBA 和 tolerance=0..255 比较，仅在显式 rect 内。纯色/渐变直接写 RGBA，渐变范围为命中连通区域的 bbox。`fill` 是 flood 的别名，不是填满整幅；旧 `bitmap fill` 保持原先整幅语义。
- brush/line/shape/text 用 native canvas；alpha 是 globalAlpha；eraser 用 destination-out。轨迹限 1..100000 个二维点，笔刷/厚度 <=10000。
- resize/full scale 随尺寸缩放中心；crop 从中心减 rect 起点；full flip/rotate 中心随仿射变换；选区变换保留资源中心。rotate 默认扩展画布，`--spec '{"expand":false}'` 可禁扩展，选区 rotate 在原画布内合成；`transform` 可在 spec 设置 pivot/matrix，resize 默认 nearest，显式 `--smoothing` 才启用平滑。
- 像素 alpha 修改是乘法，不把非透明旧像素当作全新实心色；颜色替换可以设为 `transparent`。

## 资产管理与转换

```text
asset list costume
asset list sound
asset info costume <id>
asset duplicate costume <id>
asset duplicate sound <id> --name newSound
asset reorder costume <id> 0
asset reorder sound <id> 0
asset size costume <id>
asset size costume <id> 80 60
asset center costume <id>
asset center costume <id> 20 15
asset select costume <id>
asset rename costume <id> newName
asset rename sound <id> newName
asset delete sound <id>
asset share costume <id> stage
asset export costume <id> --output drawing.svg
asset export sound <id> audio.wav
asset convert costume <id> bitmap
asset convert costume <id> vector
asset convert sound <id> wav --rate 22050
```

Costume duplicate 同字节/内容 hash、新条目 ID、新 skin，插在原项后并选中；sound duplicate 新条目 ID、新 SoundPlayer，插在原项后，修改副本不会改原声。Reorder 保留被选造型对象身份。Rename 用 VM 原函数更新积木里的资源名引用。不能删最后一件造型。

SVG→PNG 默认按 SVG viewBox 两倍尺寸 rasterize，`resolution=2`，中心平移 viewBox 起点后缩放；可明确 `--resolution 1`。Bitmap→SVG 是内嵌 PNG `image`，按 bitmapResolution 除回舞台单位，**不是自动向量描摹**。安全 native renderer 的 `rasterizeSVG` 支持内嵌 PNG 与 alpha/layer order，往返和 SB3 重载已检查实际像素。转换保留整个资产 viewport，不等价 GUI Paper 按 content bounds 裁白边或浏览器 crispEdges 栅格化。Size SVG 操作实际缩放子几何/viewBox及中心，不只改 CSS width；位图 size 为像素重采样。声音 size 是信息，没有声波的 x/y rotation center。

## 声音选区、十种效果与文件剪贴

```text
asset range sound <id> --range 0.1,0.5
asset effect sound <id> reverse --range 0.2,0.7 --units fraction
asset effect sound <id> louder --range 100,2000 --units samples
asset effect sound <id> softer
asset effect sound <id> faster
asset effect sound <id> slower
asset effect sound <id> echo
asset effect sound <id> robot
asset fade sound <id> in --range 0.1,0.5
asset fade sound <id> out --range 0.1,0.5
asset mute sound <id> --range 0.1,0.5
asset trim sound <id> 0.1 0.5
asset trim sound <id> --range 100,2000 --units samples
asset keep-range sound <id> --range 0.2,0.8 --units fraction
asset delete-range sound <id> --range 0.1,0.5
asset copy sound <id> --range 0.1,0.5 --output clip.wav
asset copy-to-new sound <id> --range 0.1,0.5 --name excerpt
asset paste sound <id> --from clip.wav --range 0.2,0.4
asset render sound <id> --range 0.1,0.5 --output preview.wav
```

单位默认 seconds；samples 为当前**decoded buffer**整数索引，fraction 用 0..1。右边界是 exclusive，秒/fraction floor 到样本。无 range 的效果/复制=全声，无 range 的 paste=追加；显式 paste range=替换选区，`start=end` 为插入点。delete-range 要明确非空 range；删整声保底一个 0 样本；trim/keep 留选区，keep 的空选区保底一个 0 样本。Channel 0 单声道行为是冻结 GUI 编辑语义，不进行可能相消的立体声 downmix。

十效果继续调用冻结 GUI `audio-effects.js` / effects 源码而非新拟算法：reverse、louder×1.25、softer×0.75、faster/slower=2^(±4/12)、echo 选区尾+0.75s、robot 环形调制、fade-in、fade-out、mute。自动化逐 sample 与独立加载的冻结 graph 对照（相同 native OfflineAudioContext），保留原 buffer 为 undo 输入，并检查调整后的 selection 和实际长度。Fade/volume/mute 边缘调度来自冻结图，不冒称瞬间全段缩放。`louder` 没有复现 GUI 按 chunk RMS 禁用按钮的 UI guard；WAV 落盘仍做 PCM16 裁剪。

Paste 解码显式 WAV 快照到该 WAV rate，再用与 GUI 同形 OfflineAudioContext source graph 一次重采样到目标 decoded rate。≥10,000,000 PCM16 bytes 的 submit 按冻结 `downsampleIfNeeded` 规则一次重采样到 22050 Hz，不虚构循环压到10MB以内。编辑 max 5000 万样本；剪贴 WAV max32 MiB。项目加载目前 Scratch AudioEngine 的44100 context会将低率输入重新解码到44100，**存储 rate 与编辑 buffer rate 可能不同**；convert 的编码 rate 可保存，但重载后的 decoded rate 不保证还是该值，时长和 PCM 经过重采样。导出原声用 `asset export` 保留原 asset 字节，预览选区用 `asset render` 输出 PCM16 WAV；没有真实播放/停止录音/麦克风能力。

## 历史、回滚与 defaults

```text
paint history
asset history
paint undo
paint redo
asset undo --out after-undo.sb3
asset redo --out after-redo.sb3
paint defaults --spec '{"brush":5,"eraser":8,"thickness":2,"fill":"#ff0000","alpha":0.5}' --output paint-defaults.json
paint defaults --config paint-defaults.json
```

历史从 `session.constructor.HISTORY_LIMIT` / `HISTORY_BYTE_LIMIT` 读取；当前为**共享项目事务最多99快照，每栈200 MiB预算，至少保留1大快照**，大项目会先逐出旧项，不是每资源独立99层GUI撤销栈。打开/新建项目重置历史。Assets、所选 target 和通用 session inputs/runtimeSettings 由主事务恢复；即时外部 cloud 状态不是编辑撤销内容。项目保存失败、绘制参数错误、native处理失败不能改变 dirty/history 或留下半个项目修改。复制导出是外部文件操作，undo 不回收快照文件。

Defaults 是显式 JSON 配置读/写，用 `--output`；命令不偷偷修改用户全局配置。后续 drawing 的 spec 显式携带配置值，当前不隐式应用 defaults 文件。

## Paint-snap 几何委托

```text
paint snap-move <costume-id> <node-id> 10 5
paint snap-scale <costume-id> <node-id> 1.5 1.2 --spec '{"shift":true}'
paint snap-scale <costume-id> <node-id> 1.5 --spec '{"handle":"bottom-right","alt":true}'
```

与 addon 的 snap action 共用 vector-editor，不重复实现：move strict x/y delta<threshold/zoom，按 point→itemSideVert→itemSideHoriz→xcoord→ycoord 优先后距离；scale strict distance<threshold/zoom，width/height优先后坐标，corner无shift取 maxabs 等比，最小scale=.0001，alt围绕中心把角位移翻倍。候选为根 peer，排所选/helper/locked/guide，不递归把组子节点当独立peer。Spec 可传 `artboard:[x,y,w,h]`、handle、shift、alt；settings 接冻结 flat keys，也可由 addon 显式 `snapSettings` 委托。

默认 page 是**资产 viewBox**；不猜测 Paper 编辑器导入时 placement/双倍坐标平移。Bounds 是 native fill geometry，排 stroke、clip/mask 的 visible bbox；文字用 native font metrics，非 Paper bounds 逐位相同。Guide/color/UI模式不写资产。阈值配置直接写数值，不复现 GUI 按钮 click 调整 bug。

## 验收与明确未达边界

新增 `test/paint-tools.test.js` / `test/asset-tools.test.js` 通过完整 CommandSession 路由验证实际 bbox、cubic 拆分/handle、PNG RGBA、native stage alpha与层序、十效果 PCM 差分、clip snapshots、SB3 重载、UUID、undo/redo及失败回滚；已有 `commands.test.js` / `m2-audio.test.js` 回归。必须使用已验证 Node24 可执行文件；宿主默认 Node26 的 CLI ABI guard 拒绝不算代码成功或失败伪装。没有用整幅 SVG replace 当绘图工具验收。

以下仍为 limited，未做 browser/Electron GUI 对拍、不宣称full parity。

1. Native canvas 与浏览器/Paper 的抗锯齿、round stroke、brush stamp/平滑、text/font fallback和SVG栅格器边缘不逐位相同；系统字体跨机器不保证。
2. Native DSP 和浏览器 compressor lookahead/robot/resampler 精度可能不同；graph/source一致只证明适配无漂移，不能代替浏览器PCM oracle。
3. SVG class/style-sheet CSS、复杂 nested text/tspan、use/nested svg、clip/mask/filter/gradient transformations 的编辑几何和继承不完整；不支持的 bounds/ungroup/eraser 明确拒绝，不能当作完整Paint导入场景。
4. 点曲线的非直线endpoint normal/curvature、弧线编辑为cubic近似、曲线长度积分；Flip不按Paper ensureClockwise规范重排path段，但仿射镜像渲染和fill winding随原SVG保留。
5. SVG→bitmap 不按GUIcontent裁边、不把shape-rendering crispEdges当全等价；Bitmap→SVG保留PNG而非tracing。当前嵌位图+文本safe rasterizer无systemfont时文本fallback需单独验收。
6. Clipboard cut+project文件不是跨文件原子事务，因此不允许共用--out。输出快照不在projectundo范围；资源选择是显式参数，不模仿GUI内存选区/自动播放。
7. 99层是有预算的shared project history，不是每编辑器独立99保证。图像操作固定位图画布clip，出界selected paste/move可能被裁；与GUI动态工作区/commit trim不是同一行为。
8. 本页没把 asset库上传/所有音频codec/实时录音/自定义字体管理动作归为本模块已交付，相关入口由其他模块/主代理负责，不改census成伪通过。
