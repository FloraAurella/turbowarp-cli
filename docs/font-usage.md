# 原生字体管理与验收边界

无需 DOM、浏览器或网络；Node 24。直接读取冻结 scratch-render-fonts 七个 WOFF2 二进制，不执行 `base64-loader!` / `document` 字体入口，不新增依赖。

## 命令

```text
font builtins
font list
font builtin Pixel
font add-builtin Marker "My Marker" --fallback sans-serif
font from-file "My Font" /absolute/font.woff2 --fallback "serif, sans-serif"
font add "My Font" /absolute/font.ttf
font custom "My Font" /absolute/font.otf
font system "Portable Metadata" --fallback serif
font inspect "My Font"
font load
font delete "My Font"
font reset
font measure "My Font" "Hello WWW" --size 24
font render "My Font" "Hello WWW" --size 24 --width 320 --height 80 --output /absolute/preview.png
font export "My Font" --output /absolute/exact-font.woff2
save /absolute/project.sb3
```

`builtin`/`add-builtin`、`add`/`from-file`/`custom` 为别名；builtins 无需当前项目，其余需先 new/open。系统字体只保存官方 FontManager metadata；原生可迁移 SVG 不枚举/加载用户机器系统字体，未知 family 回退到冻结 Sans Serif。要保证可迁移外观应导入真实 binary font，不要依赖系统字体名。

删除/reset 和字体加入是编辑操作，由主层 transaction 提供 undo/redo 和失败回滚；`--out project.sb3` 是编辑持久化。preview/export 只用 positional 或 `--output`，不得用 `--out` 混成项目保存。导出二进制与 font asset byte-identical，扩展名必须匹配格式。load 只同步当前已验证 FontManager→renderer，不修改项目内容。

family 仅 ASCII 字母/数字/空格/下划线/连字符，长度1..100；fallback 是 plain comma-separated names（允许引号），不允许任意 CSS。最多64个 customFont entry、每binary8 MiB、合计32 MiB。

## 格式、安全与真实 SB3

支持 ttf/otf/woff/woff2 magic。验证 header、文件length、table count、SFNT/WOFF目录/metadata bounds、解压预算、字体 name table 与 native font parser；并不以四字节signature或后缀当有效字体。拒绝 TTC、SVG-font、XML、CSS/URL输入、恶意扩展、坏长度和 native decode失败。font inspect返回md5/sha256/format/table count以及可解析的name记录，WOFF2 compressed name records不伪称已解码。

Project在VM载入前对customFonts metadata及每个zip/font资产验证：精确md5ext路径、缺失/歧义拒绝、hash必须匹配、family/fallback安全、无prototype键。不会允许FontManager AssetUtil缺资产回退到网络，也不会接受upstream deserialize吞错后悄然替换字体。

字体由冻结 `runtime.fontManager` 保存：`serializeJSON`→标准project.json.customFonts，`serializeAssets`→原始 `<md5>.<format>`。Project.renderer挂载后、costume SVG首次hydrate前调用fontManager.updateRenderer，保存/重开第一帧就使用正确字体。不会在自有metadata另造字体模型，也不更改字体bytes/ID。sprite3中的customFonts同样预校验；导入通过VM规范FontManager。

注意冻结scratch-storage Font的data URI MIME固定`font/ttf`，即使实际WOFF2。CLI仅将二进制signature作为格式权威，不因该上游MIME误拒合法资产。

## 原生字形与多 renderer 生命周期

安全CSS子集仅允许固定形状的一条 `@font-face {font-family:"...";src:url("data:font/...;base64,...");}`，family map一致、base64 canonical。remote/file/javascript/@import/额外rule/嵌套SVG一律拒绝。二进制全验证成功后原子替换renderer注册，不留下半加载font集。

@napi-rs/canvas GlobalFonts为进程级且对binary去重，因此采用内容SHA256 alias+引用计数：每renderer有自己的family→alias映射，使用相同font binary共享注册；peer delete/reset/dispose不会释放仍被其他renderer持有的face；最后引用释放。不将用户字体alias写回SVG asset，只在临时渲染树改写font-family。

文字SVG先在仅冻结/custom aliases的native字体上下文转换为path，再交Resvg（loadSystemFonts:false）栅格化。带embedded bitmap也使用同路径。字体更新/reset会清理已有vector MIP、更新silhouette/dirty；同一字串真实字形metrics和pixels改变，而不是只返回JSON列表。

支持SVG font-family属性、style font-family及简单style-rule替换；`font:` CSS shorthand在有text时明确拒绝，不能隐式使用hostfont。生产原生库首次加载前禁用系统及用户字体目录自动枚举，用户数据只能通过显式字体文件导入。缺字glyph/shaping/Unicode字体覆盖依据嵌入binary；冻结Sans Serif的部分CJK/Arabic/Devanagari/emoji字符在本机实查为相同缺字方框，不能称这些语言已经支持，应显式导入包含所需字形的字体。裸canvas generic family和对白字体不等同于每renderer的私有alias选择，跨会话字体确定性及GUI对拍仍pending。

## 集成

`font-commands.js`导出 `{specs:{font:{...}},requiresProject,isReadOnly,execute,booleanOptions:['force'],usesProjectTarget:false}`。min/max不计action，args包含action。只读list/builtins/inspect/export/measure/render/load；其他动作交主层transaction。renderer只依赖font模块的safe binary/CSS helpers，不依赖主commands/editor。

已有依赖@napi-rs/canvas、@resvg/resvg-js，无新package。Project字体加载时序位于attachRenderer后hydrate前；SVG paint/API的font更新走FontManager公开API即可。

## 测试与 parity

`node --test test/fonts.test.js`覆盖7builtin双hash、本地真实WOFF2 parser、CSS/URL拒绝、字形advance/bbox严格数值、preview黑像素bounds、真实stage SVG字形、custom字体asset byte/MD5/SB3首次reload像素、undo/delete/reset、已有MIP更新、peer renderer/reset/dispose及embedded bitmap文字Resvg对照。

本轮Node24.18.0验收：字体9项、font+renderer+embedded-SVG+core-boundaries+module-routing+project-I/O组合49/49全部通过、skip0；语法和whitespace检查通过。

这些是原生backend与冻结资产/源码参照验收，不是GUI oracle。字体hinting、browserSVG/CSS细节、抗锯齿、复杂script shaping及系统字体fallback的真实GUI差分仍pending，不能因nativebbox/PNG可生成就称完整字体parity。Monitor overlay未在本字体任务实现；默认舞台renderer路径保持纯Scratch图像。
