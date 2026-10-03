# M1 独立静态复核：原15项静态处置结案（R13仅候选降级）

来源为 **independent reviewer final R09 verdict（non-user peer review）**，不是human授权；文档线转录结论不自授approved。R01/R02/R03/R04/R05/R06/R07/R08/R09/R10/R11/R12/R14/R15为独立源码/账本静态pass；R13仅“未确认候选降级、不计数”处置通过，iframe执行仍unconfirmed/pending。**原15项只在静态修复处置范围结案；文档线未执行GUI、未跑CLI suite、未验收任何动作implementation，不代表全部GUI动作或N/A结案。** 源证据均相对仓库根；完整range/anchor/SHA在总账本对应动作的 `sources`。

旧统计1177条记录/1152条实际动作保留为历史；修复后以m1-census.json.stats为唯一分母，不继续沿用旧数。所有实现/验收状态仍pending。

## R01 — 画布吸管不是纯UI

- `desktop-master/node_modules/scratch-paint/src/containers/color-picker.jsx:161-165` 将onChangeColor作为回调。
- `desktop-master/node_modules/scratch-paint/src/containers/paint-editor.jsx:273-285` 在画布内回传采样色。
- `desktop-master/node_modules/scratch-paint/src/containers/color-indicator.jsx:33-79` applyColorToSelection并在关闭面板后onUpdateImage。
- 修复 `costumes.paint-eye-dropper` → 命令化提案。只采样而不应用选中图形的fixture不足以验收此动作。

## R02 — 复制是当时快照，不可用之后重读source代理

- 声音 `desktop-master/node_modules/scratch-gui/src/containers/sound-editor.jsx:317-332,375-425` 将copyBuffer保留并后续粘贴。
- 绘图 `desktop-master/node_modules/scratch-paint/src/hocs/copy-paste-hoc.jsx:30-89` exportJSON/importJSON保留Paper对象快照。
- 修复 `sounds.editor.copy`、`costumes.paint-copy` → 命令化提案。要求复制后源内容改变，粘贴仍用原快照；不能把内部/file clipboard说成无语义。

## R03 — 后台节流影响实际调度

- `desktop-master/src-main/windows/desktop-settings.js:75-79` settingsChanged。
- `desktop-master/src-main/windows/editor.js:594-596` webContents.setBackgroundThrottling。
- `desktop.pref.backgroundThrottling` 可按CLI无Electron后台窗口的OS-shell边界不适用，但理由必须明确调度副作用，不能归纯视觉。

## R04 — Gamepad打开/选设备会条件保存项目注释

- `desktop-master/node_modules/scratch-gui/src/addons/addons/gamepad/userscript.js:149-212` storeMappings和mapping/gamepad change接线。
- `desktop-master/node_modules/scratch-gui/src/addons/addons/gamepad/gamepadlib.js:730-737,1143-1155` selected controller更新/changed/export。
- 修复 `addon.gamepad.open`、`addon.gamepad.select-controller` → 条件项目写入命令化提案；store关闭时才仅视图。实时设备采集D7/D6不能掩盖magic comment存储。

## R05 — 同ID冲突隐藏了Gamepad设置Reset

- `desktop-master/node_modules/scratch-gui/src/addons/settings/settings.jsx:607-621` 插件标题Reset。
- `desktop-master/node_modules/scratch-gui/src/addons/settings-store.js:356-366` resetAddon。
- 保留 `addon.gamepad.reset` 为运行映射Reset controls；新增 `addon.gamepad.reset-settings` 恢复manifest hide设置，inventory.actionIds必须含两者。

## R06 — 九个声音动作修正为执行container证据

`desktop-master/node_modules/scratch-gui/src/containers/sound-editor.jsx` 的执行range替换原误指component/PropTypes的证据。

- copy 317-332；deleteSelection 193-215；keepSelection 216-234。
- paste 375-427；play 172-179；redo 306-316；stop 180-183。
- trim.clear 109-112,431-436；undo 295-305。
- 组件只保留触发证据时不能代替实际处理；checker强制对应执行路径。

## R07 — 声音库试听是真实PlayButton鼠标/触摸接线

- `desktop-master/node_modules/scratch-gui/src/containers/library-item.jsx:85-113,165-174` showPlayButton时普通hover跳过，并传onPlay/onStop。
- `desktop-master/node_modules/scratch-gui/src/containers/play-button.jsx:43-82` mousedown/touchstart/mouseenter/leave分支。
- 修复 `sounds.library.preview` 触发及执行证据，新增 `sounds.library.preview-stop`；不能继续认作死的状态指示器。

## R08 — 删除选区/segments不等于整图clear

- `desktop-master/node_modules/scratch-paint/src/helper/selection.js:214-263` RESHAPE先删segments，无segments才删item。
- `desktop-master/node_modules/scratch-paint/src/hocs/keyboard-shortcuts-hoc.jsx:64-68` 键盘直接deleteSelection，不执行toolbar无选区全选。
- `desktop-master/node_modules/scratch-paint/src/containers/mode-tools.jsx:198-211` toolbar先selectAll。
- `desktop-master/node_modules/scratch-paint/src/helper/selection-tools/point-tool.js:41-45,81-104,162-169` 双击删除点并调整邻接句柄。
- 明确原toolbar动作，新增 `paint.selection.keyboard-delete`、`paint.reshape.delete-segments`、`paint.reshape.doubleclick-remove-point`；其fixture不能只断言clear整图。

## R09 — MediaRecorder六项输出参数补齐

- `desktop-master/node_modules/scratch-gui/src/addons/addons/mediarecorder/userscript.js:47-196,239-328`。
- 新增 `addon.mediarecorder.option.duration/delay/project-audio/mic-mix/wait-flag/end-stop`。
- 只有mic实时采集为D7 limited；其余时长、等待、项目音轨混合、事件停止都影响输出，不能因为录视频总体未实现一概limited。

## R10 — 打包器项目ID/URL输入遗漏

- `desktop-master/src-renderer/packager/standalone.html:230` 的SelectProject.type/id/url及 `if("id"===l)`、`if("url"!==l)` 执行分支。
- 新增 `package.project-id`、`package.project-url`；metadata/token与URL下载路径区别于editor打开窗口，不能整域alias掉。

## R11 — 八个局部Reset与自定义光标自动居中补齐

- `desktop-master/src-renderer/packager/standalone.html:30` reset.confirm；`:230` 八组 `E([...])`。
- 新增 `package.reset.runtime/player/cursor/cloud/advanced/target/application/steamworks`，JSON各自保存resetKeys。
- player Reset同时清app icon/loadingScreen image blob，cursor Reset清customCursor blob；resetapplication不重置所有app字段。
- 新增 `package.cursor-auto-center`：Math.round(image.width/2)、Math.round(image.height/2)。
- 只证明pack reset能写默认值，或option数量相同，不足以证明这些组合副作用。

## R12 — 通用六权限弹窗在desktop不可达

- `desktop-master/src-renderer-webpack/editor/gui/desktop-hoc.jsx:65-74` canReadClipboard/canNotify=true；canGeolocate=false。
- `desktop-master/node_modules/scratch-gui/src/containers/tw-security-manager.jsx:164-169` 优先propsSecurityManager。
- `desktop-master/src-main/windows/project-running-window.js:71-78` clipboard/notification转主进程原生权限。
- `permission.geolocate/notify/read-clipboard.allow/deny` 六行保留为WebGUI excluded-control，不计desktop动作分母；主进程原生弹窗仍单列。保留记录不等于承诺CLI对应能力。

## R13 — embed授权政策与DOM执行分开

- `desktop-master/node_modules/scratch-gui/src/containers/tw-security-manager.jsx:404-419` Boolean返回及hostcache。
- `desktop-master/node_modules/scratch-vm/src/extension-support/tw-unsandboxed-extension-runner.js:91-96` Scratch.canEmbed只调用政策。
- `permission.embed.allow/deny` → 命令化policy提案，不是dom-only。
- 新增 `extension.embed-dom-execution` → D6 DOM-only。实现拒绝embed不能代理allow授权布尔语义，也不能代理HTML嵌入执行。

## R14 — 禁振动actionIds不应指向相机拒绝

- `desktop-master/node_modules/scratch-gui/src/addons/addons/tw-disable-vibration/userscript.js:1-29`。
- 删除该addon到 `permission.record-video.deny` 的错误引用，不删除addon。
- 新增 `addon.tw-disable-vibration.navigator-vibrate/gamepad-pulse/gamepad-play-effect`，分别false、Promise(false)、Promise("preempted")；不能忽略返回值差异。

## R15 — FaceSensing是URL扩展，不是VM builtin

- `desktop-master/node_modules/scratch-gui/src/lib/libraries/extensions/index.jsx:130-142` extensionURL为https://extensions.turbowarp.org/lab/face-sensing.js。
- `desktop-master/node_modules/scratch-gui/src/containers/extension-library.jsx:142-147` URL优先。
- `desktop-master/node_modules/scratch-vm/src/extension-support/extension-manager.js:12-29` builtin清单没有faceSensing。
- 保留兼容ID `extension.load.faceSensing`，更正URL加载/security/defaultdeny，status提案pending；D7只采集边界，JS安全执行必须独立验收。

## 第二轮partial修订（待独立复审，不自签结案）

- **R02**：copy/paste成对补 `clipboardProtocol`。声音：`asset copy sound <source> --range ... --output clipboard.wav` → `asset paste sound <dest> --from clipboard.wav`；无范围append、有范围replace，跨rate重采样。WAV量化与GUIFloat32快照的差别仍待验收。绘图：vector JSON producer/consumer同文件，bitmap PNG单独协议；root/CompoundPath选区、无选区trim bitmap、跨format rasterize、自动10*pasteOffset不能被文件存在代理。
- **R04**：改正事件链。`gamepad/userscript.js:204-212` open直接调用handleEditorControllerChanged；`gamepad/gamepadlib.js:730-733` select→updateContent→gamepad-changed；`740-744` updateAllContent不发event。handler仅store=true时保存magic comment，不再写错误updateAllContent→mapping-changed。
- **R07**：声明/写入 `touchStarted`，但`play-button.jsx:49,52,80`读取 `touchstarted`。报告记录实际拼写异常，不能写正常touch免stop承诺。
- **R08**：`selection.js:226-249` seg.remove不执行`point-tool.js:81-104`双击removePoint邻接手柄补偿。`paint.reshape.delete-segments`是toolbar/keyboard的子分支，移为不计数alias；两原动作各存subbranches。双击独立 `paint.reshape.doubleclick-remove-point` 提案带`--double-click`，不能同一普通point-delete冒充两个语义。
- **R09**：`mediarecorder/userscript.js:248-255` NotAllowedError/NotFoundError将micEnabled=false继续，其他error抛出；`:308` duration timeout先安排，`:314-328` delay之后`:325` recorder.start，因此duration计时包含delay，不是start后完整时长。
- **R10**：source去重key改为(path,line,endLine,anchor)，保留长行`:230`中两个真正 `P=async` 的id/url执行anchor；SelectProject.type只是输入模式证据，不足以代替执行。
- **R13**：未提供规范固化的decoded `iframe.js.br`源码路径/行号/SHA，故 `extension.embed-dom-execution`改unconfirmed-candidate/pending，不计desktop分母；权限提示不是iframe执行证据，不自授dom-only。待原`createFrame:97-115/display:327-341→canEmbed`实际decoded代码证据。
- **R15**：补GUI `tw-security-manager.jsx:26-34`官方URL自动trust、`:235-240`unsandboxed、`:257-260`true；desktop `project-running-window.js:124-128` HTTPS extensions.turbowarp.org→tw-extensions本地redirect。safe JS执行与Face识别fixture仍pending；不是通用手动prompt路径。

## 最后三项精确修订（R04/R07/R09静态PASS，不含运行验收）

- **R04** `gamepad/userscript.js:149-177`：storeMappings先editor.export，若null早return无写入；store=true必要非充分，只有有效export才创建/更新comment及didChangeProject。open/select保留187-212实际事件链并补完整store执行source，不能只靠设置开关推导必然写项目。
- **R07** `sounds.library.preview-stop` 的trigger改为playing mousedown/touchstart，或mouseleave且错误小写`state.touchstarted`为假则stop。由于写入camelcase `touchStarted`，touch开启也可能mouseleave stop；不再有“非touch移出”矛盾描述。
- **R09** `mediarecorder/userscript.js:217-237` 的inactive guard精确条件：**若duration timeout实际早于recorder.start触发**，227因recorder.state=inactive返回ignored；后续start没有同一duration timer再次停止。`:316-319`整秒delay每秒等待975ms，`:327`余数等待fraction*1000ms，因此**名义delay>=duration不是充分条件**；duration=10/delay=10的名义start约9.75s，timer未必在inactive时触发，调度开销另影响实际先后。CLI拒绝该range是保守的intentional difference／pending，不冒充上游分支条件，不能称GUI全等价。

## gate和检查口径

- 原15项静态修复处置已独立结案（14源码/账本static-pass，R13只未确认候选降级处置pass）；不代表全部动作独立not-applicable审结。action-acceptance只能保存具体审状态和候选，其他N/A需独立逐项批准。
- 所有总账本implementationStatus/acceptanceStatus继续pending，不以spec存在、测试名数量或源码SHA检查升级。
- `coverage-check.py` 补充15项动作存在、处置、执行路径、WebGUI计数、Gamepad两个Reset、六recorder选项/八resetkeys/三振动API及FaceSensingURL约束。
- 主线程报告资产输入gate已解：官方desktop v1.16 Linux tar/asar回收1304/1304，check-baseline missing0/errors0，301extensions/81addons hashes通过；MIT direct download=0。这里不复跑/混来源，四类libraryload仍待主线程实际测试。
