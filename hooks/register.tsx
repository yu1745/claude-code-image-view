import type { EngineInterface, Register, RenderComponent, RenderInput } from 'claude-code'

// 能显示的图片后缀；非 PNG 的由 ImageMagick 转成 PNG
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|ico)$/i
// ![alt](path) / ![alt](<path with spaces>)，可带 "title"
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g
const CACHE_DIR = '/tmp/cc-image-view'
// 图片有两种交给终端的方式：
//  file   只传文件路径，由终端自己读取解码：原图画质，不占引擎的字节预算（默认，本机终端）
//  inline 把 PNG 的 base64 放进渲染树：终端读不到这台机器的文件时（ssh）用，受下面的预算限制
// 引擎限制：一棵渲染树里所有 inline Image 的 source 加起来不超过 2 MiB，超了整棵树会被丢弃。
// 按 base64 长度保守计，一次渲染（一条回复 / 一组 Read）共用这一份预算
const TREE_IMAGE_BUDGET = 2 * 1024 * 1024
// inline：单张 PNG 上限（解码后）。取小一点，一条回复里才放得下几张；超过就继续缩小
const MAX_PNG_BYTES = 700 * 1024
// inline：缩小的边长梯度
const RESIZE_EDGES = [1200, 900, 700, 500, 350]
// file：非 PNG 转换时的最长边，只为避免超大图拖慢终端解码
const FILE_MAX_EDGE = 2400
// file 来源的路径最长 3072 字节，超过就退回 inline
const MAX_FILE_PATH_BYTES = 3072
const MAX_COLUMNS = 80
// 默认高度的绝对上限；实际上限随终端行数走：视口行数 / ROWS_DIVISOR，至少 MIN_ROWS
const MAX_ROWS = 30
const MIN_ROWS = 6
const ROWS_DIVISOR = 3
// 每按一次“放大/缩小”，占的行列乘或除以这个数
const SCALE_STEP = 1.5
const MIN_SCALE = 0.3
// 一个 Image 最多 255 列 × 255 行
const MAX_CELLS = 255

type Prepared =
  | { state: 'loading' }
  | { state: 'ready'; source: PngSource; width: number; height: number }
  | { state: 'error'; message: string }

type Engine = EngineInterface
type PngSource = { png: string } | { file: string; format: 'png'; generation: number }
// 消息当前在不在视口里：null 表示在视口外（只在全屏布局下有值）
type OnScreen = { first: number; last: number; of: number } | null | undefined
// 一棵树里还能放多少 Image source（base64 长度）；每次渲染新建一份，画图时扣减
type Budget = { left: number }
const newBudget = (): Budget => ({ left: TREE_IMAGE_BUDGET })

const onScreenOf = (props: object): OnScreen => (props as { onScreen?: OnScreen }).onScreen

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

async function identify($: Engine, path: string) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'identify', '-format', '%w %h %m\n', `${path}[0]`,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `identify 失败 (${exitCode})`)
  const [w, h, format] = (stdout.split('\n')[0] ?? '').split(' ')
  return { width: Number(w), height: Number(h), format: format ?? '' }
}

// file / inline / auto；auto 在 ssh 会话里用 inline（终端读不到这台机器的文件）
type SourceMode = 'auto' | 'file' | 'inline'
const SOURCE_MODES: readonly SourceMode[] = ['auto', 'file', 'inline']
const SOURCE_MODE_KEY = 'imageSource'
let sourceMode: SourceMode | undefined

const describeSource = (mode: SourceMode) => ({
  auto: '图片来源：auto（本机终端传文件路径，ssh 会话里内联 base64）',
  file: '图片来源：file（传文件路径，原图画质；终端必须能读到这台机器的文件）',
  inline: '图片来源：inline（内联 base64，会缩小到总量预算内）',
})[mode]

async function loadSourceMode($: Engine): Promise<SourceMode> {
  if (sourceMode) return sourceMode
  const stored = await $.store.get(SOURCE_MODE_KEY)
  sourceMode = SOURCE_MODES.find(m => m === stored) ?? 'auto'
  return sourceMode
}

async function useInline($: Engine): Promise<boolean> {
  const mode = await loadSourceMode($)
  if (mode !== 'auto') return mode === 'inline'
  // webterm（浏览器里的 xterm.js）只支持直接传输，读不到本机文件，和 ssh 一样走 inline
  const r = await $.process.run(['sh', '-c', 'printf %s "$SSH_CONNECTION$SSH_TTY$WEBTERM_SESSION"'])
  return r.exitCode === 0 && r.stdout.trim() !== ''
}

const hex = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 准备好终端能显示的 PNG：file 来源是一个 PNG 文件路径，inline 来源是缩小后的 base64 */
async function toPng($: Engine, path: string): Promise<Prepared> {
  const info = await identify($, path)
  const { size } = await $.fs.stat(path)
  const inline = (await useInline($)) || new TextEncoder().encode(path).length > MAX_FILE_PATH_BYTES

  if (!inline) {
    if (info.format === 'PNG') {
      return {
        state: 'ready', width: info.width, height: info.height,
        source: { file: path, format: 'png', generation: size },
      }
    }
    const out = `${CACHE_DIR}/${await hex(`${path}:${size}:file`)}.png`
    await $.process.run(['mkdir', '-p', CACHE_DIR])
    const r = await $.process.run([
      'convert', `${path}[0]`, '-resize', `${FILE_MAX_EDGE}x${FILE_MAX_EDGE}>`, '-strip', `png:${out}`,
    ], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `convert 失败 (${r.exitCode})`)
    const converted = await identify($, out)
    return {
      state: 'ready', width: converted.width, height: converted.height,
      source: { file: out, format: 'png', generation: (await $.fs.stat(out)).size },
    }
  }

  if (info.format === 'PNG' && size <= MAX_PNG_BYTES) {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    return { state: 'ready', source: { png: base64 }, width: info.width, height: info.height }
  }

  const out = `${CACHE_DIR}/${await hex(`${path}:${size}`)}.png`
  await $.process.run(['mkdir', '-p', CACHE_DIR])
  // 逐级缩小，直到不超过单张上限
  for (const edge of RESIZE_EDGES) {
    const r = await $.process.run([
      'convert', `${path}[0]`, '-resize', `${edge}x${edge}>`, '-strip', `png:${out}`,
    ], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `convert 失败 (${r.exitCode})`)
    if ((await $.fs.stat(out)).size <= MAX_PNG_BYTES) break
  }
  const small = await identify($, out)
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  return { state: 'ready', source: { png: base64 }, width: small.width, height: small.height }
}

/**
 * 按图片比例算出占多少行列：一个字符格大约宽:高 = 1:2。
 * scale 是 1 时不超过 MAX_COLUMNS × maxRows（maxRows 随终端行数变化，见 MAX_ROWS）；
 * 放大后只受终端宽度和 Image 的格数上限限制，比屏幕高的图跟着对话一起滚动。
 */
function cellsOf(
  width: number, height: number,
  viewportColumns: number | undefined, viewportRows: number | undefined, scale: number,
) {
  // 左边缩进 2 格，再留一点边
  const widest = Math.min(MAX_CELLS, Math.max(8, (viewportColumns ?? 100) - 4))
  const maxRows = viewportRows === undefined
    ? MAX_ROWS
    : Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(viewportRows / ROWS_DIVISOR)))
  const rowsFor = (columns: number) => Math.round((columns * height) / width / 2)
  const columnsFor = (rows: number) => Math.round((rows * 2 * width) / height)

  let columns = Math.min(MAX_COLUMNS, widest, Math.ceil(width / 8))
  if (rowsFor(columns) > maxRows) columns = Math.max(1, columnsFor(maxRows))

  const base = columns
  columns = Math.round(base * scale)
  let atLimit = false
  if (columns >= widest) { columns = widest; atLimit = true }
  if (rowsFor(columns) >= MAX_CELLS) { columns = columnsFor(MAX_CELLS); atLimit = true }
  columns = Math.max(1, Math.min(MAX_CELLS, columns))
  // applied：夹过之后实际生效的倍数，下一次放大缩小从它算起
  return {
    columns, rows: Math.max(1, Math.min(MAX_CELLS, rowsFor(columns))), atLimit,
    applied: atLimit ? columns / base : scale,
  }
}

// 默认展开方式（/image-view 设置，存在 $.store 里跨会话保留）：
// auto 回复里的图展开、Read 的图折叠；on 全部展开；off 全部折叠
type OpenMode = 'auto' | 'on' | 'off'
const OPEN_MODES: readonly OpenMode[] = ['auto', 'on', 'off']
const OPEN_MODE_KEY = 'defaultOpen'
let openMode: OpenMode | undefined

async function loadOpenMode($: Engine): Promise<OpenMode> {
  if (openMode) return openMode
  const stored = await $.store.get(OPEN_MODE_KEY)
  openMode = OPEN_MODES.find(m => m === stored) ?? 'auto'
  return openMode
}

async function defaultOpen($: Engine, kind: 'read' | 'reply'): Promise<boolean> {
  const mode = await loadOpenMode($)
  return mode === 'auto' ? kind === 'reply' : mode === 'on'
}

const describeMode = (mode: OpenMode) => ({
  auto: '图片默认展开方式：auto（回复里的图片展开，Read 的图片折叠）',
  on: '图片默认展开方式：on（全部默认展开）',
  off: '图片默认展开方式：off（全部默认折叠）',
})[mode]

const prepared = new Map<string, Prepared>()
// 每个图片块的展开状态；没有记录时用该块的默认值
const expanded = new Map<string, boolean>()
// 每个图片块的显示倍数：占的行列相对默认大小放大或缩小了多少
const scales = new Map<string, number>()

function ensure($: Engine, path: string) {
  if (prepared.has(path)) return
  prepared.set(path, { state: 'loading' })
  toPng($, path)
    .catch((err: unknown): Prepared => ({
      state: 'error',
      message: err instanceof Error ? err.message : String(err),
    }))
    .then(result => {
      prepared.set(path, result)
      $.ui.invalidate('ui.render')
    })
}

async function resolvePath($: Engine, raw: string) {
  let p = raw.replace(/^file:\/\//, '')
  try { p = decodeURI(p) } catch {}
  if (p.startsWith('/')) return p
  return `${(await $.session.cwd()).replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`
}

/** 一个图片块：一行按钮 + 文件名，展开时下面是图片 */
function imageBlock(
  $: Engine,
  e: RenderInput<RenderComponent, 'terminal'>,
  id: string,
  path: string,
  alt: string,
  openByDefault: boolean,
  budget: Budget,
  onScreen: OnScreen,
) {
  const { Box, Text, Button, Image } = $.ui.resolve(e)
  const open = expanded.get(id) ?? openByDefault
  if (open) ensure($, path)
  const p = prepared.get(path)
  const scale = scales.get(id) ?? 1
  const setScale = (s: number) => () => { scales.set(id, s); $.ui.invalidate('ui.render') }

  let body = null
  let controls = null
  // 只有 inline 来源的 base64 会进渲染树、占预算；file 来源只是一个路径
  const cost = p?.state === 'ready' && 'png' in p.source ? p.source.png.length : 0
  if (open && p?.state === 'ready' && cost > 0 && onScreen === null) {
    // 滚出视口：inline 图不进渲染树（终端会按上次的行数占位），滚回来时本消息会重绘
    body = <Text dimColor>图片在视口外，滚动到这里时显示</Text>
  } else if (open && p?.state === 'ready' && cost > budget.left) {
    // 引擎会丢掉超过预算的整棵树，所以这张不画，让已画的几张照常显示
    body = <Text dimColor>本条消息里的图片总量已达显示上限（{TREE_IMAGE_BUDGET >> 20} MiB），这张暂不显示；收起其他图片后再展开</Text>
  } else if (open && p?.state === 'ready') {
    budget.left -= cost
    const { columns, rows, atLimit, applied } = cellsOf(
      p.width, p.height, e.viewport?.columns, e.viewport?.rows, scale)
    body = (
      <Image key={`img:${id}`} source={p.source} columns={columns} rows={rows}
        alt={`[图片 ${alt || basename(path)} ${p.width}×${p.height}]`} />
    )
    controls = (
      <Box flexDirection="row" gap={1}>
        {!atLimit && <Button key={`grow:${id}`} label="放大" dimColor
          onPress={setScale(applied * SCALE_STEP)} />}
        {applied / SCALE_STEP >= MIN_SCALE && columns > 1 && rows > 1 && <Button key={`shrink:${id}`}
          label="缩小" dimColor onPress={setScale(applied / SCALE_STEP)} />}
        {scale !== 1 && <Button key={`reset:${id}`} label="复位" dimColor onPress={setScale(1)} />}
        <Text dimColor>{columns}×{rows} 格</Text>
      </Box>
    )
  } else if (open && p?.state === 'error') {
    body = <Text color="red">图片无法显示：{p.message}</Text>
  } else if (open) {
    body = <Text dimColor>正在加载图片…</Text>
  }

  return (
    <Box key={`blk:${id}`} flexDirection="column" marginLeft={2}>
      <Box flexDirection="row" gap={1}>
        <Button key={`btn:${id}`} label={open ? '收起图片' : '展开图片'} dimColor
          onPress={() => { expanded.set(id, !open); $.ui.invalidate('ui.render') }} />
        <Text dimColor>{alt && alt !== basename(path) ? `${alt} · ` : ''}{path}</Text>
      </Box>
      {controls}
      {body}
    </Box>
  )
}

const imageReadPath = (tool: string, input: unknown) => {
    if (tool !== 'Read' || typeof input !== 'object' || input === null) return null
    const p = (input as { file_path?: unknown }).file_path
    return typeof p === 'string' && IMAGE_EXT.test(p) ? p : null
  }

export const register: Register = on => {
  // 单独显示的 Read 行：结果下面加一个折叠的图片块
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface !== 'terminal') return drawn
    const { tool, input, isRunning, isErrored, tool_use_id } = e.props
    const path = imageReadPath(tool, input)
    if (!path || isRunning || isErrored) return drawn
    const { Box } = $.ui.resolve(e)
    const open = await defaultOpen($, 'read')
    return (
      <Box flexDirection="column">
        {drawn}
        {imageBlock($, e, tool_use_id, path, '', open, newBudget(), onScreenOf(e.props))}
      </Box>
    )
  })

  // 折叠成一行的 "Read N files"：给其中每张图片各加一个折叠的图片块
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface !== 'terminal' || e.props.isExpanded) return drawn
    const budget = newBudget()
    const open = await defaultOpen($, 'read')
    const blocks = e.props.calls.flatMap((c, i) => {
      const path = imageReadPath(c.tool, c.input)
      if (!path || c.isRunning || c.isErrored) return []
      return [imageBlock($, e, c.tool_use_id ?? `${e.requestId}:${i}`, path, '', open, budget, onScreenOf(e.props))]
    })
    if (blocks.length === 0) return drawn
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {blocks}
      </Box>
    )
  })

  // 回复里的 ![alt](path)：默认展开显示
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface !== 'terminal') return drawn
    const found = [...e.props.text.matchAll(MD_IMAGE)]
      .map(m => ({ alt: m[1] ?? '', raw: m[2] ?? m[3] ?? '' }))
      .filter(m => IMAGE_EXT.test(m.raw) && !/^https?:/i.test(m.raw))
    if (found.length === 0) return drawn
    const budget = newBudget()
    const open = await defaultOpen($, 'reply')
    // 先解析完路径再依次画，预算按出现顺序扣
    const paths = await Promise.all(found.map(m => resolvePath($, m.raw)))
    const blocks = found.map((m, i) =>
      imageBlock($, e, `${e.requestId}:${i}`, paths[i]!, m.alt, open, budget, onScreenOf(e.props)))
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {blocks}
      </Box>
    )
  })

  // /image-view [on|off|auto]：设置图片默认展开还是折叠；不带参数显示当前设置
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'image-view',
      description: '设置图片默认展开(on)、折叠(off)或自动(auto)；不带参数显示当前设置',
      argumentHint: '[on|off|auto]',
    })
    return next(e)
  })

  on('command.run', { command: 'image-view' }, async ($, e) => {
    const [first = '', second = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const usage = '用法：/image-view on|off|auto　　/image-view source auto|file|inline'
    const current = await loadOpenMode($)
    const currentSource = await loadSourceMode($)
    if (first === '') return { text: `${describeMode(current)}\n图片来源：${currentSource}\n${usage}` }

    if (first === 'source') {
      const picked = SOURCE_MODES.find(m => m === second)
      if (!picked) return { text: `未知参数 "${second}"。${usage}\n图片来源：${currentSource}` }
      await $.store.set(SOURCE_MODE_KEY, picked)
      sourceMode = picked
      prepared.clear() // 重新按新来源准备
      $.ui.invalidate('ui.render')
      return { text: describeSource(picked) }
    }

    const mode = OPEN_MODES.find(m => m === first)
    if (!mode) return { text: `未知参数 "${first}"。${usage}\n${describeMode(current)}` }
    await $.store.set(OPEN_MODE_KEY, mode)
    openMode = mode
    // 已手动展开/收起的块也回到新的默认值
    expanded.clear()
    $.ui.invalidate('ui.render')
    return { text: describeMode(mode) }
  })

  // 告诉模型：交付图片时用 Markdown 图片语法引用本地绝对路径，终端会直接显示
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    return {
      ...r,
      blocks: [
        ...r.blocks,
        {
          name: 'imageView',
          text: 'The terminal renders images inline. When you produce or want to show the user a local image file (a chart you plotted, a screenshot, a generated picture), reference it in your reply with Markdown image syntax and an absolute path, e.g. `![p95 latency](/abs/path/chart.png)`; it is drawn under your message. Images you Read get an expand button automatically, so do not re-embed those unless asked.',
        },
      ],
    }
  })
}
