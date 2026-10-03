# tw-cli 功能对等矩阵（M1源码账本复核）

基线：当前仓库冻结 desktop-master/node_modules/scratch-gui、scratch-blocks、scratch-paint、scratch-vm 与 desktop src-main/src-renderer-webpack；具体路径/行号/anchor/SHA 在总账本。
权威账本：[census/m1-census.json](census/m1-census.json)；可读总表：[census/m1-census.md](census/m1-census.md)；81插件：[addons-inventory.json](addons-inventory.json) / [addons-disposition.md](addons-disposition.md)。

## 最终账本统计（不是发布验收）

- 账本记录：**1202**；实际已确认动作：**1170**；被动指示10；不渲染控件20；未确认候选2。
- 重复ID：**0**；缺失必需区域：**0**；必填字段缺失：**0**（以 coverage-check.py 只读校验为准）。
- 六稿322原始行全部复核：同ID重复1行移除，跨稿重复动作3组去重；四个缺失区域已补齐。旧总JSON250记录不能继续当分母。
- 提案处置：commanded=476, dom-only=4, limited=177, not-applicable=460, pending=85。
- 全部账本记录 `implementationStatus=pending`、`acceptanceStatus=pending`。同名命令代码存在仅说明子集实现；未逐动作验证CLI参数/语义/fixture时不升级。
- `coverageComplete=false`；full-parity **未验收、不可发布为全对等**。静态缺失数0不等于动态扩展/真实设备或行为对拍缺口0。

## 决策记录

| 决策 | 边界 |
| --- | --- |
| D1 | 原生离屏渲染/音频输出文件获准；GUI图像/音频差分对拍未验收，不承诺实时扬声器。 |
| D3 | 云变量为本地文件/进程通道；desktop使用BroadcastChannel，不连接真实云服务。 |
| D4 | 旧IndexedDB/localStorage数据迁移由桌面版负责；背包/收藏/插件设置/还原点新文件库为提案，不自动解析旧用户库。 |
| D5 | 默认deny、显式授权、零交互；安全弹窗allow/deny登记不意味着对应设备/网络能力已实现。 |
| D6 | 冻结81 addons逐项处置；不承诺任意未来JS/CSS/HTML DOM插件。 |
| D7 | 实时摄像头/麦克风limited，预录文件/帧/音频管道；不泛化为全部BLE硬件禁止。 |

## 按区域汇总与验收要求

| 区域 | 记录数 | 能力与CLI提案（未验收） | 验收前必须补齐 |
| --- | --- | --- | --- |
| [menu-bar](census/menu-bar.md) | 59 | open/save/new/title、FPS/Turbo/cloud/username；菜单/主题/UI/不渲染项逐项not-applicable | 本地SB3/SB2/SB打开、原子写原路径/另存、脏标记；桌面save-separate确实不渲染。 |
| [code-workspace](census/code-workspace.md) | 57 | block/field/var/list/proc/comment/monitor/undo/clipboard、脚本点击运行；缩放/Help单独列 | Blockly事件与VM图连接/ID/shadow、调用signature、注释坐标/恢复栈、扩展任意按钮。 |
| [sprites](census/sprites.md) | 48 | 增删改/duplicate/export/selected/property/reorder/共享/folder前缀 | fencing/名字引用/layerOrder/共享ID/变量冲突/文件夹排序/背包D4。 |
| [costumes](census/costumes.md) | 32 | costume/backdrop/library/upload/GIF/asset rename/export/duplicate/reorder | SVG sanitize/字体/库字节/格式转换、rename引用、背景作用于全部targets。 |
| [sounds](census/sounds.md) | 50 | 录制D7，文件上传/库/编辑10音效/WAV预览D1 | 立体声降单声道、>10MB降采样、效果参数/选区/undo99层、音频差分。 |
| [stage-controls](census/stage-controls.md) | 35 | run/stop、key/mouse/wheel/drag/colorpick；全屏窗口not-applicable | 事件时序、wasDragged、可见性中间态/图层、renderer碰撞取色像素、帧率和modifier组合。 |
| [monitors-prompts](census/monitors-prompts.md) | 54 | 列表逐项编辑/insert/delete/resize/CSV、范围/modes/ask-answer、过程Prompt、12高级选项 | monitor序列化/范围minmax小数点/isDiscrete、runtime选项保存注释、默认隐显/ANSWER线程。 |
| [extensions-addons](census/extensions-addons.md) | 591 | 内置扩展、gallery/custom、安全逐权限、外设；81插件148设置13预设 | 四项unconfirmed复杂addon、沙箱/权限/defaultdeny、动态按钮、真实设备固件及微控件穷尽。 |
| [project-io](census/project-io.md) | 170 | 文件/URL/Scratch/sample、还原点/本地背包、native菜单/设置/packager全部绑定 | SB2/SB字节、URLtoken/D5、快照D4、10用户UI偏好与内部metadata区分、全部packager target/安全。 |
| [paint-tools](census/paint-tools.md) | 106 | 每工具选择与绘制、变形/颜色/透明/渐变/font/convert/group/order/clipboard | Paper/位图真实几何及像素/字体/预览对拍；replace整图不能当完整绘图工具验收。 |

## 81 addons 处置与冻结边界

commanded=32, dom-only=1, limited=12, not-applicable=32, pending=4；implementation/acceptance均pending，fullyDispositioned=false。
必须继续确认 block-switching、editor-devtools、paint-snap、swap-local-global；pending项保留命令化目标和原因，不能删掉或混成dom-only。
纯布局外观32项not-applicable仍在inventory；blocks2image单独dom-only，因为输出实际Blockly SVG/CSS而非舞台截图。

## 独立静态复核

原15项可静态修复处置已结案：14源码/账本static-pass，R13仅unconfirmed候选降级处置pass、不批准iframe执行；来源为independent reviewer final R09 verdict（non-user peer review）。具体执行证据见 [independent-review-notes.md](census/independent-review-notes.md)。旧1177/1152分母只保留历史；R08分支去重及R13未确认iframe不计desktop分母。源码range/anchor/SHA检查不是语义正确性的代理，不称全部审结。

## 现有CLI代码只证明子集（未升级账本状态）

- `src/project.js` 已有SB/SB2/SB3转换与真实fixture，但批准可执行扩展仍仅pen/music、拒绝任意extensionURLs；不能把 ext load URL/file/text拒绝路径当实现。
- 新 `src/package-commands.js` 的pack有选项/config/build实际spec；旧package固定HTML/ZIP接口仍独立。所有GUI字段输出及多平台target需精确fixture与主线程测试，不按optioncount升级。
- run批量frames/fps/answer/input、monitor等子集可见源码，但stop/pause/step/任意动态扩展/实时gamepad/真实硬件不是同名能力自动已实现。
- 这些源码行会被其他代码线更新；总账本 partialCliCounterparts 记录读取时path:line，审阅本线未执行/修改CLI代码。

## 明确仍未覆盖/未确认/未验收

- `m1.dynamic-extension-buttons`：code-ws.extension-button 是任意 runtime callback dispatcher；远程画廊和自定义 JS 的按钮集合不封闭，不能宣称逐第三方扩展全量覆盖。
- `m1.project-file-drop`：确认了 asset drop 与拖放路径权限 IPC，未找到 desktop GUI .sb3 项目 drop 的执行接线；候选 project-io.drop-project-file 保留。
- `m1.addon-semantic-confirmation`：opcode/shadow/连接、清理删除/undo、吸附优先级/几何、作用域/云/monitor 保真仍需逐分支复核；清单条目完整不等于此四项已确认。
- `m1.runtime-addon-microcontrols`：固定paint-snap/onion-skinning微控件、Gamepad每设备/按钮/轴的参数化动作类型、debugger各tab/导航已补齐。实际设备数量/运行中线程/动态第三方扩展数据项仍是开放集合；仅静态类型普查，未实机验收。
- `m1.desktop-roles-version`：macOS services/editMenu/windowMenu 为 Electron 内置动态 roles；已登记 role，OS/Electron 按版本扩出的每个菜单项无法仅凭仓库冻结完全枚举。
- `m1.gui-parity-acceptance`：无 GUI 操作对拍、音频/画图精度/字体/权限设备/packager全部target/三平台验收；本线不运行会写项目或启动 GUI 的命令。
- `m1.offline-library-assets`：主线程已独立check-baseline：1304/1304官方desktopv1.16 Linux tar/asar回收资产，missing0/errors0，301extensions/81addons hash通过；MIT直接下载0，来源不混淆。资产输入gate解决不自动验收四类library load。

## 发布门禁与只读检查

任何implementation/acceptance pending、unconfirmed、缺少fixture或差分判据的命令化项目都阻止full-parity。limited必须附边界并验收允许损失；not-applicable/dom-only必须保留源码理由。
运行 `python3 tw-cli/docs/census/coverage-check.py`（只读）：JSON解析、重复ID、必需区域、必填、源码range/anchor/SHA、Markdown与JSON、81manifest及148设置/13预设引用一致。
检查通过只表示账本结构及源码引用一致，不表示M2/M6/M7、平台安全/设备/packager/音频画图对拍完成。
