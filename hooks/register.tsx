import type { EngineInterface, Register, RenderComponent, RenderInput } from 'claude-code'

// 能显示的图片后缀；非 PNG 的由 ImageMagick 转成 PNG
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|ico)$/i
// ![alt](path) / ![alt](<path with spaces>)，可带 "title"
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g
const CACHE_DIR = '/tmp/cc-image-view'
// Image 元素直接传的 PNG 数据上限是 2 MiB（解码后）
const MAX_PNG_BYTES = 2 * 1024 * 1024
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
  | { state: 'ready'; png: string; width: number; height: number }
  | { state: 'error'; message: string }

type Engine = EngineInterface

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

async function identify($: Engine, path: string) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'identify', '-format', '%w %h %m\n', `${path}[0]`,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `identify 失败 (${exitCode})`)
  const [w, h, format] = (stdout.split('\n')[0] ?? '').split(' ')
  return { width: Number(w), height: Number(h), format: format ?? '' }
}

/** 读出（必要时转换、缩小）成 PNG 的 base64 */
async function toPng($: Engine, path: string): Promise<Prepared> {
  const info = await identify($, path)
  const { size } = await $.fs.stat(path)
  if (info.format === 'PNG' && size <= MAX_PNG_BYTES) {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    return { state: 'ready', png: base64, width: info.width, height: info.height }
  }

  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${path}:${size}`))
  const name = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  const out = `${CACHE_DIR}/${name}.png`
  await $.process.run(['mkdir', '-p', CACHE_DIR])

  // 先限制到 1600px，还超 2 MiB 就继续缩小
  for (const edge of [1600, 1000, 600]) {
    const r = await $.process.run([
      'convert', `${path}[0]`, '-resize', `${edge}x${edge}>`, '-strip', `png:${out}`,
    ], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `convert 失败 (${r.exitCode})`)
    if ((await $.fs.stat(out)).size <= MAX_PNG_BYTES) break
  }
  const small = await identify($, out)
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  return { state: 'ready', png: base64, width: small.width, height: small.height }
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
) {
  const { Box, Text, Button, Image } = $.ui.resolve(e)
  const open = expanded.get(id) ?? openByDefault
  if (open) ensure($, path)
  const p = prepared.get(path)
  const scale = scales.get(id) ?? 1
  const setScale = (s: number) => () => { scales.set(id, s); $.ui.invalidate('ui.render') }

  let body = null
  let controls = null
  if (open && p?.state === 'ready') {
    const { columns, rows, atLimit, applied } = cellsOf(
      p.width, p.height, e.viewport?.columns, e.viewport?.rows, scale)
    body = (
      <Image key={`img:${id}`} source={{ png: p.png }} columns={columns} rows={rows}
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
    return (
      <Box flexDirection="column">
        {drawn}
        {imageBlock($, e, tool_use_id, path, '', false)}
      </Box>
    )
  })

  // 折叠成一行的 "Read N files"：给其中每张图片各加一个折叠的图片块
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface !== 'terminal' || e.props.isExpanded) return drawn
    const blocks = e.props.calls.flatMap((c, i) => {
      const path = imageReadPath(c.tool, c.input)
      if (!path || c.isRunning || c.isErrored) return []
      return [imageBlock($, e, c.tool_use_id ?? `${e.requestId}:${i}`, path, '', false)]
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
    const blocks = await Promise.all(found.map(async (m, i) =>
      imageBlock($, e, `${e.requestId}:${i}`, await resolvePath($, m.raw), m.alt, true)))
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {blocks}
      </Box>
    )
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
