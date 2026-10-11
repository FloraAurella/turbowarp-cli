# 实际 CLI 指令索引

此文件由实际注册的命令 schema 生成。存在命令不等于对应全部 GUI 动作已经验收；完整状态以 completion-audit 和动作账本为准。

示例：`./tw help paint` 查看绘图语法，`./tw help runtime` 查看运行控制；`--project` 读取指定项目，编辑命令 `--out` 保存 SB3。

## addon

```text
addon 指令参考
addon list：位置参数 0..0；选项 --config 值
addon inspect：位置参数 1..1；选项 --config 值
addon get：位置参数 1..1；选项 --config 值
addon enabled：位置参数 1..2；选项 --config 值
addon setting：位置参数 2..3；选项 --config 值
addon default：位置参数 0..1；选项 --config 值
addon defaults：位置参数 0..1；选项 --config 值
addon reset：位置参数 0..1；选项 --config 值
addon reset-setting：位置参数 2..2；选项 --config 值
addon presets：位置参数 1..2；选项 --config 值
addon preset：位置参数 2..2；选项 --config 值
addon commands：位置参数 0..1；选项 无
addon block-count：位置参数 0..0；选项 --project 值 --target 值 --shadows
addon find：位置参数 1..1；选项 --project 值 --target 值 --kind 值
addon switch：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --input-map 值 --field-map 值 --inputs 值 --fields 值
addon rename-broadcast：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
addon initial-sprite：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force --config 值 --x 值 --y 值
addon move-layer：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force
addon variables：位置参数 0..1；选项 --project 值 --target 值
addon set-variable：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
addon set-list：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
addon rename-variable：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
addon replace-variable：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
addon swap-scope：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --cloud 值
addon cleanup-plus：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force --delete-orphans --delete-unused --make-space 值 --gap 值
addon copy-single：位置参数 1..2；选项 --project 值 --target 值 --output 值 --force
addon copy-all：位置参数 0..0；选项 --project 值 --target 值 --output 值 --force
addon cut-single：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --output 值
addon paste-at：位置参数 0..1；选项 --project 值 --target 值 --out 值 --force --at 值 --variables 值
addon snap-move：位置参数 4..4；选项 --project 值 --target 值 --out 值 --force --config 值 --zoom 值 --threshold 值 --spec 值
addon snap-scale：位置参数 3..4；选项 --project 值 --target 值 --out 值 --force --config 值 --zoom 值 --threshold 值 --spec 值
addon costume-next：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
addon costume-previous：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## asset

```text
asset 指令参考
asset list：位置参数 1..1；选项 --project 值 --target 值
asset info：位置参数 2..2；选项 --project 值 --target 值
asset duplicate：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --name 值
asset reorder：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
asset size：位置参数 2..4；选项 --project 值 --target 值 --out 值 --force --smoothing
asset center：位置参数 2..4；选项 --project 值 --target 值 --out 值 --force
asset convert：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force --rate 值 --resolution 值
asset blank：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --width 值 --height 值 --resolution 值
asset select：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
asset rename：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
asset delete：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
asset export：位置参数 2..3；选项 --project 值 --target 值 --output 值 --force
asset share：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force --name 值
asset effect：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值
asset trim：位置参数 2..4；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值
asset fade：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值
asset mute：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值
asset delete-range：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值
asset keep-range：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值
asset copy：位置参数 2..3；选项 --project 值 --target 值 --range 值 --units 值 --output 值 --force
asset paste：位置参数 2..3；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值 --from 值
asset copy-to-new：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --range 值 --units 值 --name 值
asset range：位置参数 2..2；选项 --project 值 --target 值 --range 值 --units 值
asset render：位置参数 2..3；选项 --project 值 --target 值 --range 值 --units 值 --output 值 --force
asset history：位置参数 0..0；选项 --project 值
asset undo：位置参数 0..0；选项 --project 值 --out 值 --force
asset redo：位置参数 0..0；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## backpack

```text
backpack 指令参考
backpack use：位置参数 1..1；选项 无
backpack list：位置参数 0..0；选项 --dir 值
backpack save：位置参数 2..3；选项 --project 值 --target 值 --out 值 --force --dir 值
backpack load：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --dir 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## bitmap

```text
bitmap 指令参考
bitmap resize：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
bitmap flip-x：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
bitmap flip-y：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
bitmap fill：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
bitmap convert：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## block

```text
block 指令参考
block list：位置参数 0..0；选项 --project 值 --target 值
block add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --inputs 值 --fields 值 --after 值 --parent 值 --input 值
block field：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
block input：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
block move：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --after 值 --parent 值 --input 值
block delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## blocks

```text
blocks 指令参考
blocks schema：位置参数 0..1；选项 --project 值 --target 值
blocks list：位置参数 0..0；选项 --project 值 --target 值
blocks inspect：位置参数 0..1；选项 --project 值 --target 值 --block 值 --mode 值 --single
blocks count：位置参数 0..0；选项 --project 值 --target 值 --shadows
blocks find：位置参数 0..1；选项 --project 值 --target 值 --opcode 值 --field 值 --value 值 --var-id 值
blocks add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --inputs 值 --fields 值 --mutation 值 --after 值 --parent 值 --input 值 --at 值
blocks duplicate：位置参数 0..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --single --block 值 --at 值
blocks copy：位置参数 0..2；选项 --project 值 --target 值 --mode 值 --single --output 值 --force --block 值
blocks export：位置参数 0..2；选项 --project 值 --target 值 --mode 值 --single --output 值 --force --block 值
blocks cut：位置参数 0..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --single --block 值 --output 值
blocks paste：位置参数 0..1；选项 --project 值 --target 值 --out 值 --force --at 值 --from 值 --variables 值
blocks import：位置参数 0..1；选项 --project 值 --target 值 --out 值 --force --at 值 --from 值 --variables 值
blocks share：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --single --at 值 --variables 值
blocks switch：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --input-map 值 --field-map 值 --inputs 值 --fields 值
blocks connect：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --after 值 --parent 值 --input 值
blocks disconnect：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --single --heal --at 值
blocks heal：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --at 值
blocks move：位置参数 1..3；选项 --project 值 --target 值 --out 值 --force --at 值
blocks cleanup：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force --at 值 --gap 值 --columns 值 --column-width 值
blocks clean-up：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force --at 值 --gap 值 --columns 值 --column-width 值
blocks delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --single --heal
blocks clear：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
blocks set-field：位置参数 0..3；选项 --project 值 --target 值 --out 值 --force --block 值 --field 值 --value 值 --var-id 值
blocks field-menu：位置参数 2..2；选项 --project 值 --target 值
blocks mutation：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
blocks procedure-add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --params 值 --warp 值 --type 值 --at 值
blocks procedure-call：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --values 值 --after 值 --parent 值 --input 值 --at 值
blocks procedure-edit：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --name 值 --params 值 --warp 值 --type 值
blocks procedure-delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## broadcast

```text
broadcast 指令参考
broadcast list：位置参数 0..0；选项 --project 值
broadcast add：位置参数 1..1；选项 --project 值 --out 值 --force
broadcast rename：位置参数 2..2；选项 --project 值 --out 值 --force
broadcast delete：位置参数 1..1；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## capabilities

```text
capabilities 指令参考
capabilities：位置参数 0..0；选项 --json
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## check

```text
check 指令参考
check：位置参数 0..0；选项 无
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## cloud

```text
cloud 指令参考
cloud use：位置参数 1..1；选项 --project 值
cloud list：位置参数 0..0；选项 --project 值
cloud sync：位置参数 0..0；选项 --project 值
cloud add：位置参数 1..2；选项 --project 值 --out 值 --force
cloud get：位置参数 1..1；选项 --project 值
cloud set：位置参数 2..2；选项 --project 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## comment

```text
comment 指令参考
comment list：位置参数 0..0；选项 --project 值 --target 值
comment add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --block 值
comment set：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
comment move：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
comment delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## costume

```text
costume 指令参考
costume list：位置参数 0..0；选项 --project 值 --target 值
costume add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
costume use：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
costume rename：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
costume delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
costume export：位置参数 2..2；选项 --project 值 --target 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## device

```text
device 指令参考
device capabilities：位置参数 0..0；选项 --output 值 --force
device permissions：位置参数 0..0；选项 --output 值 --force
device permission：位置参数 2..2；选项 无
device input-list：位置参数 0..0；选项 --project 值 --output 值 --force
device video-frame：位置参数 1..1；选项 --project 值 --frame 值 --output 值 --force --mirror 值
device loudness：位置参数 1..1；选项 --project 值 --frame 值 --output 值 --force --format 值 --sample-rate 值 --channels 值
device gamepad：位置参数 1..1；选项 --project 值 --frame 值 --output 值 --force
device key：位置参数 2..2；选项 --project 值 --frame 值 --output 值 --force
device mouse：位置参数 2..3；选项 --project 值 --frame 值 --output 值 --force --button 值
device wheel：位置参数 1..2；选项 --project 值 --frame 值 --output 值 --force
device user-data：位置参数 1..1；选项 --project 值 --frame 值 --output 值 --force
device cloud：位置参数 2..2；选项 --project 值 --frame 值 --output 值 --force
device replay：位置参数 1..1；选项 --project 值 --validate-only --output 值 --force
device socket-mock：位置参数 0..1；选项 --output 值 --force
device camera：位置参数 0..0；选项 无
device microphone：位置参数 0..0；选项 无
device scan：位置参数 0..1；选项 --extension 值
device connect：位置参数 0..1；选项 --extension 值 --peripheral 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## doctor

```text
doctor 指令参考
doctor：位置参数 0..0；选项 --json
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## exit

```text
exit 指令参考
exit：位置参数 0..0；选项 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## ext

```text
ext 指令参考
ext help：位置参数 0..0；选项 无
ext list：位置参数 0..1；选项 无
ext inspect：位置参数 1..1；选项 无
ext doc：位置参数 1..2；选项 --output 值 --force
ext load：位置参数 1..1；选项 --project 值 --out 值 --force --allow 值
ext load-file：位置参数 1..1；选项 --allow 值
ext load-text：位置参数 1..1；选项 --allow 值
ext load-url：位置参数 1..1；选项 --allow 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## font

```text
font 指令参考
font list：位置参数 0..0；选项 --project 值
font builtins：位置参数 0..0；选项 无
font inspect：位置参数 1..1；选项 --project 值
font builtin：位置参数 1..2；选项 --project 值 --out 值 --force --fallback 值
font add-builtin：位置参数 1..2；选项 --project 值 --out 值 --force --fallback 值
font add：位置参数 2..2；选项 --project 值 --out 值 --force --fallback 值
font from-file：位置参数 2..2；选项 --project 值 --out 值 --force --fallback 值
font custom：位置参数 2..2；选项 --project 值 --out 值 --force --fallback 值
font system：位置参数 1..1；选项 --project 值 --out 值 --force --fallback 值
font delete：位置参数 1..1；选项 --project 值 --out 值 --force
font reset：位置参数 0..0；选项 --project 值 --out 值 --force
font load：位置参数 0..0；选项 --project 值
font export：位置参数 1..2；选项 --project 值 --output 值 --force
font measure：位置参数 2..2；选项 --project 值 --size 值
font render：位置参数 2..3；选项 --project 值 --output 值 --force --size 值 --width 值 --height 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## gamepad

```text
gamepad 指令参考
gamepad create：位置参数 0..1；选项 --project 值 --allow 值 --target 值 --frame 值 --index 值 --buttons 值 --axes 值 --empty 值
gamepad show：位置参数 0..0；选项 --project 值 --allow 值 --target 值 --output 值 --force
gamepad set-button：位置参数 2..2；选项 --project 值 --allow 值 --target 值 --frame 值
gamepad set-axis：位置参数 2..2；选项 --project 值 --allow 值 --target 值 --frame 值
gamepad select-controller：位置参数 1..1；选项 --project 值 --allow 值
gamepad reset：位置参数 0..0；选项 --project 值 --allow 值 --target 值 --frame 值 --empty 值
gamepad export：位置参数 0..1；选项 --project 值 --allow 值 --target 值 --output 值 --force
gamepad import：位置参数 1..1；选项 --project 值 --allow 值 --target 值 --frame 值
gamepad store：位置参数 1..1；选项 --project 值 --allow 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## help

```text
help 指令参考
help：位置参数 0..1；选项 --json
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## history

```text
history 指令参考
history：位置参数 0..0；选项 --project 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## info

```text
info 指令参考
info：位置参数 0..0；选项 --project 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## input

```text
input 指令参考
input key：位置参数 2..2；选项 --project 值
input mouse：位置参数 2..3；选项 --project 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## library

```text
library 指令参考
library categories：位置参数 1..1；选项 --dir 值
library list：位置参数 1..1；选项 --dir 值 --category 值 --query 值 --offset 值 --limit 值
library search：位置参数 2..2；选项 --dir 值 --category 值 --offset 值 --limit 值
library load：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --dir 值
library status：位置参数 0..0；选项 --dir 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## list

```text
list 指令参考
list all：位置参数 0..0；选项 --project 值 --target 值
list get：位置参数 1..1；选项 --project 值 --target 值
list add：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force
list append：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
list clear：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
list set：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
list insert：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
list replace：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
list remove：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
list rename：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
list delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## monitor

```text
monitor 指令参考
monitor list：位置参数 0..0；选项 --project 值
monitor add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
monitor set：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
monitor delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## monitors

```text
monitors 指令参考
monitors list：位置参数 0..0；选项 --project 值
monitors show：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
monitors hide：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
monitors mode：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
monitors move：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
monitors size：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
monitors range：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
monitors import-list：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --format 值 --column 值
monitors export-list：位置参数 2..2；选项 --project 值 --target 值 --format 值
monitors value：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
monitors set-item：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
monitors insert-item：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
monitors delete-item：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## new

```text
new 指令参考
new：位置参数 0..1；选项 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## open

```text
open 指令参考
open：位置参数 1..1；选项 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## pack

```text
pack 指令参考
pack help：位置参数 0..0；选项 无
pack inspect：位置参数 0..1；选项 无
pack get：位置参数 1..1；选项 无
pack set：位置参数 2..2；选项 --allow 值
pack config：位置参数 1..1；选项 --allow 值
pack reset：位置参数 0..1；选项 无
pack reset-group：位置参数 1..1；选项 无
pack cursor-center：位置参数 0..0；选项 --allow 值
pack export：位置参数 0..1；选项 --output 值 --force
pack import：位置参数 1..1；选项 --allow 值
pack build：位置参数 0..1；选项 --project 值 --output 值 --target 值 --allow 值 --cache 值 --force --opt 值
pack preview：位置参数 0..1；选项 --project 值 --output 值 --allow 值 --cache 值 --force --opt 值
pack targets：位置参数 0..0；选项 无
pack download：位置参数 1..1；选项 --cache 值 --allow 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## package

```text
package 指令参考
package：位置参数 0..1；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## paint

```text
paint 指令参考
paint nodes：位置参数 1..1；选项 --project 值 --target 值 --mode 值 --nodes 值 --rect 值
paint source：位置参数 1..1；选项 --project 值 --target 值 --mode 值 --nodes 值 --rect 值
paint select：位置参数 1..1；选项 --project 值 --target 值 --mode 值 --nodes 值 --rect 值
paint add：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值
paint rectangle：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint rect：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint ellipse：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint circle：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint line：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint path：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint brush：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint text：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值 --outlined --size 值
paint erase：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --size 值 --alpha 值
paint copy：位置参数 1..2；选项 --project 值 --target 值 --mode 值 --nodes 值 --rect 值 --output 值 --force
paint cut：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --output 值
paint paste：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --from 值 --spec 值 --dx 值 --dy 值 --x 值 --y 值 --alpha 值 --smoothing
paint delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint clear：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint crop：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint clone：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --dx 值 --dy 值
paint group：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint ungroup：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint order：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --direction 值
paint align：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --direction 值
paint distribute：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --direction 值
paint transform：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --dx 值 --dy 值 --smoothing
paint move：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --dx 值 --dy 值
paint rotate：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --expand --smoothing
paint scale：位置参数 2..3；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --smoothing
paint resize：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --smoothing
paint skew：位置参数 2..3；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值
paint flip-x：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint flip-y：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值
paint style：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值
paint fill：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值
paint fill-all：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --alpha 值
paint flood：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --alpha 值
paint text-style：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --fill 值 --stroke 值 --stroke-width 值 --alpha 值 --fill-alpha 值 --stroke-alpha 值 --gradient 值 --property 值 --hue 值 --saturation 值 --brightness 值 --font 值 --font-size 值 --font-weight 值 --text-anchor 值
paint text-set：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --text 值
paint gradient-swap：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --property 值
paint points：位置参数 1..2；选项 --project 值 --target 值 --mode 值 --nodes 值 --rect 值 --path 值
paint point-add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --path 值 --segments 值 --spec 值 --after 值 --t 值
paint point-delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --path 值 --segments 值 --spec 值 --after 值 --t 值
paint point-set：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --path 值 --segments 值 --spec 值 --after 值 --t 值
paint pointed：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --path 值 --segments 值 --spec 值 --after 值 --t 值
paint curved：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --path 值 --segments 值 --spec 值 --after 值 --t 值
paint sample：位置参数 1..3；选项 --project 值 --target 值 --mode 值 --nodes 值 --rect 值 --spec 值
paint eyedropper：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --property 值
paint replace-color：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --from-color 值 --to-color 值 --alpha 值
paint opacity：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --alpha 值
paint snap-move：位置参数 4..4；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --config 值 --zoom 值
paint snap-scale：位置参数 3..4；选项 --project 值 --target 值 --out 值 --force --mode 值 --nodes 值 --rect 值 --spec 值 --config 值 --zoom 值
paint defaults：位置参数 0..0；选项 --config 值 --output 值 --force --spec 值
paint history：位置参数 0..0；选项 --project 值
paint undo：位置参数 0..0；选项 --project 值 --out 值 --force
paint redo：位置参数 0..0；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## permission

```text
permission 指令参考
permission help：位置参数 0..0；选项 无
permission list：位置参数 0..0；选项 无
permission inspect：位置参数 0..0；选项 无
permission log：位置参数 0..0；选项 无
permission check：位置参数 1..1；选项 --allow 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## pref

```text
pref 指令参考
pref list：位置参数 0..0；选项 --config 值
pref get：位置参数 1..1；选项 --config 值
pref set：位置参数 2..2；选项 --config 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## proc

```text
proc 指令参考
proc list：位置参数 0..0；选项 --project 值 --target 值
proc define：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --params 值
proc call：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force --values 值 --after 值
proc rename：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
proc delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## project

```text
project 指令参考
project read：位置参数 0..0；选项 --project 值 --target 值 --script 值 --format 值
project find：位置参数 1..1；选项 --project 值 --target 值 --opcode 值 --resource 值
project validate：位置参数 1..1；选项 --project 值
project apply：位置参数 1..1；选项 --project 值 --out 值 --force
project exec：位置参数 1..1；选项 --project 值 --out 值 --force
project fetch：位置参数 1..2；选项 --output 值 --force --allow 值 --max-bytes 值 --timeout-ms 值
project import：位置参数 1..1；选项 --project 值 --out 值 --force
project import-sprite：位置参数 1..1；选项 --project 值 --out 值 --force
project export-sprite：位置参数 0..1；选项 --project 值 --target 值 --output 值 --force
project export：位置参数 0..1；选项 --project 值 --output 值 --force
project restore-use：位置参数 1..1；选项 无
project restore-list：位置参数 0..0；选项 --dir 值
project restore-save：位置参数 1..1；选项 --project 值 --dir 值
project restore：位置参数 1..1；选项 --project 值 --dir 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## quit

```text
quit 指令参考
quit：位置参数 0..0；选项 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## record

```text
record 指令参考
record capabilities：位置参数 0..0；选项 --output 值 --allow 值
record start：位置参数 0..1；选项 --project 值 --output 值 --format 值 --duration 值 --delay 值 --fps 值 --waitflag 值 --flag-frame 值 --stopOnStop 值 --stop-frame 值 --projectaudio 值 --microphonemix 值 --audio-track 值 --mic-track 值 --soundfiles 值 --encoder 值 --probe 值 --allow 值 --answer 值 --seed 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## redo

```text
redo 指令参考
redo：位置参数 0..0；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## render

```text
render 指令参考
render：位置参数 0..1；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## run

```text
run 指令参考
run：位置参数 0..0；选项 --project 值 --out 值 --force --frames 值 --fps 值 --answer 值 --compile --turbo --seed 值 --watch 值 --target 值 --trace 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## runtime

```text
runtime 指令参考
runtime start：位置参数 0..0；选项 --project 值 --fps 值 --compile --no-compile --turbo --seed 值 --paused --watch 值 --target 值 --trace 值 --max-frames 值 --lifetime 值 --answer 值
runtime pause：位置参数 0..0；选项 无
runtime resume：位置参数 0..0；选项 无
runtime stop：位置参数 0..0；选项 无
runtime status：位置参数 0..0；选项 无
runtime step：位置参数 0..1；选项 --frames 值 --thread 值
runtime input：位置参数 1..4；选项 --frame 值 --button 值
runtime answer：位置参数 1..1；选项 --frame 值 --question 值
runtime watch：位置参数 0..2；选项 --target 值 --limit 值
runtime trace：位置参数 0..1；选项 --limit 值 --since 值
runtime breakpoint：位置参数 0..2；选项 --target 值 --limit 值 --since 值
runtime clones：位置参数 0..0；选项 无
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## save

```text
save 指令参考
save：位置参数 0..1；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## script

```text
script 指令参考
script demo：位置参数 0..1；选项 --project 值 --target 值 --out 值 --force
script validate：位置参数 1..1；选项 --project 值 --target 值
script apply：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## sense

```text
sense 指令参考
sense color：位置参数 1..1；选项 --project 值 --target 值
sense touching：位置参数 1..1；选项 --project 值 --target 值
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## settings

```text
settings 指令参考
settings list：位置参数 0..0；选项 --project 值
settings schema：位置参数 0..0；选项 无
settings get：位置参数 1..1；选项 --project 值
settings set：位置参数 2..2；选项 --project 值 --out 值 --force
settings size：位置参数 2..2；选项 --project 值 --out 值 --force
settings store：位置参数 0..0；选项 --project 值 --out 值 --force
settings reset：位置参数 0..0；选项 --project 值 --out 值 --force
settings export：位置参数 1..1；选项 --project 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## sound

```text
sound 指令参考
sound list：位置参数 0..0；选项 --project 值 --target 值
sound add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
sound rename：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
sound delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
sound export：位置参数 2..2；选项 --project 值 --target 值 --force
sound render：位置参数 2..2；选项 --project 值 --target 值 --force --volume 值 --pan 值 --pitch 值
sound effect：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
sound trim：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## sprite

```text
sprite 指令参考
sprite list：位置参数 0..0；选项 --project 值
sprite select：位置参数 1..1；选项 --project 值
sprite set：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
sprite rename：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
sprite add：位置参数 1..1；选项 --project 值 --out 值 --force --file 值
sprite duplicate：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
sprite delete：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
sprite front：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
sprite back：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## stage

```text
stage 指令参考
stage info：位置参数 0..0；选项 --project 值
stage tempo：位置参数 1..1；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## targets

```text
targets 指令参考
targets list：位置参数 0..0；选项 --project 值
targets info：位置参数 0..0；选项 --project 值 --target 值
targets find：位置参数 1..1；选项 --project 值
targets reorder：位置参数 2..2；选项 --project 值 --out 值 --force
targets layer：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
targets draggable：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
targets effect：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
targets clear-effects：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
targets folder-create：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
targets folder-add：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
targets folder-remove：位置参数 0..0；选项 --project 值 --target 值 --out 值 --force
targets folder-rename：位置参数 2..2；选项 --project 值 --out 值 --force
targets folder-remove-all：位置参数 1..1；选项 --project 值 --out 值 --force
targets export：位置参数 1..1；选项 --project 值 --target 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## undo

```text
undo 指令参考
undo：位置参数 0..0；选项 --project 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## var

```text
var 指令参考
var list：位置参数 0..0；选项 --project 值 --target 值
var add：位置参数 1..2；选项 --project 值 --target 值 --out 值 --force --type 值
var set：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
var rename：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
var delete：位置参数 1..1；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```

## vector

```text
vector 指令参考
vector source：位置参数 1..1；选项 --project 值 --target 值
vector nodes：位置参数 1..1；选项 --project 值 --target 值
vector replace：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
vector add：位置参数 3..9；选项 --project 值 --target 值 --out 值 --force
vector set：位置参数 4..4；选项 --project 值 --target 值 --out 值 --force
vector translate：位置参数 4..4；选项 --project 值 --target 值 --out 值 --force
vector scale：位置参数 3..4；选项 --project 值 --target 值 --out 值 --force
vector rotate：位置参数 3..3；选项 --project 值 --target 值 --out 值 --force
vector delete：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
vector front：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
vector back：位置参数 2..2；选项 --project 值 --target 值 --out 值 --force
--project 用于打开文件；编辑命令 --out 保存 SB3；run --out 导出 PNG；资源和 pack 导出使用 --output 或位置参数。
```
