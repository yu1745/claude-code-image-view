# image-view

Claude Code 的一个 mod：**在终端里直接显示图片**。

- `Read` 读到的图片会多出一个 `[ 展开图片 ]` 按钮，点开就在对话里显示，可 `放大` / `缩小` / `复位`。
- 模型回复里的 `![alt](/绝对路径.png)` 会被直接渲染成图片（默认展开）。
- 自动告诉模型"交付图片时用 Markdown 图片语法引用本地绝对路径"，你不用手动提示。
- 非 PNG（jpg、gif、webp、svg、heic…）通过 ImageMagick 转成 PNG。
- 本机终端默认只把**文件路径**交给终端读取，保持原图画质，不受引擎 2 MiB 渲染树上限影响；ssh 会话里自动退回内联 base64（缩小到预算内，且只渲染视口内的图）。
- `/image-view on|off|auto` 控制默认展开还是折叠。
- 默认显示高度跟随终端行数（最多占终端高度的 1/3，6～30 行之间），不会一张图占满一屏；需要看大图时点"放大"。

## 要求

| 依赖 | 说明 |
|---|---|
| Claude Code | **≥ 2.1.287**（该版本起支持 Claude Mods，见 changelog）；已在 2.1.296 上验证，更早的版本未测试 |
| 支持 kitty 图片协议的终端 | kitty、Ghostty 等；其他终端只显示 alt 文字 |
| ImageMagick | 需要 `identify` 和 `convert` 命令；纯 PNG 且 ≤2 MiB 的图也要用 `identify` 读尺寸 |

Debian / Ubuntu：`sudo apt install imagemagick`；macOS：`brew install imagemagick`。

## 安装

在 Claude Code 的终端会话里输入：

```
/plugin install image-view --marketplace yu1745/claude-code-image-view
```

提示 `Add marketplace?` 时输入 `y`，再选择安装范围（user 即对所有会话生效），看到 `Installed image-view. Plugin is now active.` 即完成，无需重启。

让 AI 帮你装：把 [INSTALL_FOR_AI.md](./INSTALL_FOR_AI.md) 丢给它。

### 本地开发 / 试用

```bash
git clone https://github.com/yu1745/claude-code-image-view.git
claude --plugin-dir ./claude-code-image-view
```

## 使用

1. 让 Claude 读一张图片（`Read /path/to/pic.png`），结果下面会出现 `[ 展开图片 ]`，点击展开。
2. 展开后的按钮：
   - `放大` / `缩小`：每次乘或除 1.5 倍，状态按图片块单独保存。
   - `复位`：回到默认大小。
   - 右边的 `N×M 格` 显示当前占的列数 × 行数。
3. 让 Claude 把生成的图（图表、截图）用 `![说明](/绝对路径)` 发给你，直接显示在回复下面。

## 命令

| 命令 | 作用 |
|---|---|
| `/image-view` | 显示当前设置 |
| `/image-view on` | 所有图片默认展开 |
| `/image-view off` | 所有图片默认折叠 |
| `/image-view auto` | 回复里的图展开，Read 的图折叠（默认） |
| `/image-view source auto\|file\|inline` | 图片交给终端的方式：`auto` 本机传路径、ssh 内联；`file` 总是传路径；`inline` 总是内联 base64 |

设置存在 mod 的 `$.store` 里，跨会话保留；切换展开方式会重置已手动展开/收起的块。

### 为什么有 file 和 inline 两种来源

引擎限制一棵渲染树里所有内联图片的 source 合计不超过 2 MiB（超了整棵树被丢弃，日志里是
`more than 2097152 bytes of Image source in one tree`）。`file` 来源只传路径，由终端自己读取和解码，
所以没有这个上限，也不需要缩小。终端读不到这台机器的文件时（ssh 远程）才需要 `inline`：此时每张图
缩小到 ≤700 KiB，一次渲染的总量按 2 MiB 预算，超出的图显示一行提示；全屏布局下滚出视口的图不进渲染树。

## 默认尺寸规则

一个字符格按宽:高 = 1:2 估算：

```
columns = min(80, 终端宽 - 4, ceil(图宽 / 8))
rows    = round(columns × 图高 / 图宽 / 2)
rows > maxRows 时按 maxRows 反推 columns
maxRows = clamp(终端行数 / 3, 6, 30)   // 终端行数未知时取 30
```

例：40 行终端里，960×540 的截图默认 46×13 格；小于 640 像素宽的图按 `宽/8` 列显示，会比较小，可点"放大"。
放大后只受终端宽度和单个 Image 255×255 格的上限限制，超过屏幕高度的图随对话一起滚动。

可调常量在 `hooks/register.tsx` 顶部：`MAX_COLUMNS`、`MAX_ROWS`、`MIN_ROWS`、`ROWS_DIVISOR`、`SCALE_STEP`、`MIN_SCALE`。

## 已知限制

- `viewport.rows` 只在宽度或 props 变化时更新；只改窗口高度不会让已显示的图重新计算。
- 展开状态和放大倍数保存在 mod 的内存里，热重载或重启会话后恢复默认。
- 只处理本地文件，`http(s)://` 图片链接会被忽略。
- `auto` 用 `SSH_CONNECTION` / `SSH_TTY` 判断是否 ssh；判断不对时用 `/image-view source file|inline` 手动指定。
- “只渲染视口内”依赖引擎给出的 `onScreen`，只在全屏布局下有值，且只对 inline 来源有意义。
- 同一路径的文件被覆盖后，当前会话内仍显示旧图（缓存按路径）。

## 目录结构

```
.claude-plugin/plugin.json        mod 清单
.claude-plugin/marketplace.json   让本仓库可作为 marketplace 安装
hooks/hooks.json                  声明 hooks 模块
hooks/register.tsx                全部逻辑
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。
