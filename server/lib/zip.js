// 最小 zip 读取器（零依赖）：仅支持 method 0（stored）/ 8（deflate-raw），
// 用于玩家上传 zip 的服务端解包。不支持加密条目与 zip64（直接拒绝，不猜）。
// 防护：路径穿越条目拒绝、条目数/解压总大小/单文件大小上限（zip bomb）、CRC32 校验。
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

// ---- CRC32 ----
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

export function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

// zip 规范：flags bit11 = 文件名为 UTF-8；否则按 ASCII 处理（含高位字节的罕见编码按 utf8 兜底解码）
function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8')
  for (const b of buf) if (b > 0x7f) return buf.toString('utf8')
  return buf.toString('latin1')
}

export function looksLikeZip(buf) {
  return (
    buf.length >= 4 &&
    ((buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7) && (buf[3] === 4 || buf[3] === 6 || buf[3] === 8)))
  )
}

/**
 * 解析 zip Buffer → [{ name, data }]（目录条目剔除）。
 * opts: { maxEntries=500, maxFileBytes=64MB, maxTotalBytes=64MB }
 * 任何结构异常直接 throw（Error.message 面向用户可读）。
 */
export function readZip(buf, opts = {}) {
  const maxEntries = opts.maxEntries ?? 500
  const maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024
  const maxTotalBytes = opts.maxTotalBytes ?? 64 * 1024 * 1024

  // 从尾部找 EOCD（允许注释段最长 64KB）
  let eocd = -1
  const scanFloor = Math.max(0, buf.length - 22 - 65536)
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 解析失败：找不到结束目录（文件损坏或不是 zip）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip 不支持：zip64 格式')

  const entries = []
  let p = cdOffset
  let total = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip 解析失败：中央目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const lfhOffset = buf.readUInt32LE(p + 42)
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags).replace(/\\/g, '/')
    p += 46 + nameLen + extraLen + commentLen

    if (flags & 0x1) throw new Error(`zip 不支持：条目已加密（${name}）`)
    if (method !== 0 && method !== 8) throw new Error(`zip 不支持：压缩方法 ${method}（${name}）`)
    if (name.endsWith('/')) continue // 目录条目
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`zip 不支持：危险路径条目（${name}）`)
    if (uncompSize > maxFileBytes) throw new Error(`zip 条目过大（${name}，${uncompSize} 字节）`)

    // 数据定位以 local file header 自身的 nameLen/extraLen 为准（规范允许 extra 与中央目录不一致）
    if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== LFH_SIG) throw new Error('zip 解析失败：本地头损坏')
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26)
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28)
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen
    if (dataStart + compSize > buf.length) throw new Error(`zip 解析失败：数据截断（${name}）`)
    const comp = buf.subarray(dataStart, dataStart + compSize)

    let data
    if (method === 0) {
      data = Buffer.from(comp)
    } else {
      try {
        data = zlib.inflateRawSync(comp, { maxOutputLength: maxFileBytes + 1 })
      } catch {
        throw new Error(`zip 解压失败：deflate 数据损坏（${name}）`)
      }
    }
    if (data.length !== uncompSize) throw new Error(`zip 校验失败：大小不符（${name}）`)
    if (crc32(data) !== crc) throw new Error(`zip 校验失败：CRC 不符（${name}）`)

    total += data.length
    if (total > maxTotalBytes) throw new Error('zip 解压总大小超过上限（疑似 zip bomb）')
    if (entries.length >= maxEntries) throw new Error(`zip 条目数超过上限（${maxEntries}）`)
    entries.push({ name, data })
  }
  return entries
}
