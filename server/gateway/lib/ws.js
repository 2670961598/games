/* =====================================================================
 * 最小 RFC6455 WebSocket 服务端（GAMES-40）——零依赖红线下的自研实现。
 * 设计口径：只做网关需要的事——文本帧收发、ping/pong、close、分片重组；
 *   不做 permessage-deflate（协商头直接不回，客户端自然退化为纯文本）。
 * 帧格式（RFC6455 §5）：
 *   0                   1                   2                   3
 *   FIN|RSV|OPCODE  |MASK|LEN127  |  MASKING-KEY(0/4B)  |  PAYLOAD
 *   服务端→客户端帧不掩码；客户端→服务端帧必须掩码（否则协议错断连）。
 * 长度：126 → 后 2 字节 u16；127 → 后 8 字节 u64（安全上限截断）。
 * ===================================================================== */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MSG = 1 << 20 // 1MB 消息上限（JSON 房间消息远小于此）

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

/** 服务端→客户端帧编码（不掩码） */
export function encodeFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.allocUnsafe(2)
    head[1] = len
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4)
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.allocUnsafe(10)
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  head[0] = 0x80 | opcode // FIN=1
  return Buffer.concat([head, payload])
}

/** 接收缓冲区 → 帧列表（返回 [frames, rest]；不完整帧留在 rest） */
export function parseFrames(buf) {
  const frames = []
  let off = 0
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p); p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      const big = buf.readBigUInt64BE(p); p += 8
      if (big > BigInt(MAX_MSG)) throw Object.assign(new Error('frame too large'), { code: 'too-large' })
      len = Number(big)
    }
    if (len > MAX_MSG) throw Object.assign(new Error('frame too large'), { code: 'too-large' })
    const maskLen = masked ? 4 : 0
    if (p + maskLen + len > buf.length) break // 帧未收全
    let payload = buf.subarray(p + maskLen, p + maskLen + len)
    if (masked) {
      const mask = buf.subarray(p, p + 4)
      const out = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
      payload = out
    }
    frames.push({ opcode, payload, fin: (b0 & 0x80) !== 0 })
    off = p + maskLen + len
  }
  return [frames, buf.subarray(off)]
}

/** 升级并包裹一条连接：socket 变成 WsConn（EventEmitter: 'message'/'close'/'error'） */
export class WsConn extends EventEmitter {
  constructor(req, socket) {
    super()
    this.socket = socket
    this.writable = true
    this._buf = Buffer.alloc(0)
    this._frag = null // 分片重组缓冲 {opcode, chunks}

    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
    )
    socket.setNoDelay(true)
    socket.on('data', (d) => this._onData(d))
    socket.on('error', () => this._teardown())
    socket.on('close', () => this._teardown())
    socket.on('end', () => this._teardown())
  }

  _onData(d) {
    this._buf = this._buf.length === 0 ? d : Buffer.concat([this._buf, d])
    let frames
    try {
      ;[frames, this._buf] = parseFrames(this._buf)
    } catch (err) {
      this.close(1009, 'too large')
      return
    }
    for (const f of frames) {
      if (f.opcode === OP.CLOSE) {
        // 回 close 帧后断连（尽力而为）
        try {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000
          this.socket.write(encodeFrame(OP.CLOSE, (() => { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(code, 0); return b })()))
        } catch { /* 对端已断 */ }
        this.socket.end()
        this._teardown()
        return
      }
      if (f.opcode === OP.PING) { this.socket.write(encodeFrame(OP.PONG, f.payload)); continue }
      if (f.opcode === OP.PONG) { this.emit('pong'); continue }
      if (f.opcode === OP.TEXT || f.opcode === OP.BINARY || f.opcode === OP.CONT) {
        // 分片重组：首帧记 opcode，CONT 追加；只有 FIN=1 才交付（网关消息均为小 JSON，分片属罕见但须正确）
        if (f.opcode === OP.CONT) {
          if (!this._frag) continue
          this._frag.chunks.push(f.payload)
        } else {
          this._frag = { opcode: f.opcode, chunks: [f.payload] }
        }
        if (f.fin) {
          const full = Buffer.concat(this._frag.chunks)
          this._frag = null
          if (full.length > MAX_MSG) { this.close(1009, 'too large'); return }
          this.emit('message', full.toString('utf8'), f.opcode === OP.BINARY)
        }
      }
    }
  }

  send(text) {
    if (!this.writable) return false
    try {
      this.socket.write(encodeFrame(OP.TEXT, Buffer.from(String(text), 'utf8')))
      return true
    } catch {
      return false
    }
  }

  close(code = 1000, reason = '') {
    if (!this.writable) return
    const r = Buffer.from(reason, 'utf8')
    const b = Buffer.allocUnsafe(2 + r.length)
    b.writeUInt16BE(code, 0)
    r.copy(b, 2)
    try { this.socket.write(encodeFrame(OP.CLOSE, b)) } catch { /* 已断 */ }
    this.socket.end()
    this._teardown()
  }

  _teardown() {
    if (!this.writable) return
    this.writable = false
    this.emit('close')
  }
}

/** 挂到 http server：只暴露一次 handleUpgrade，路由由调用方决定 */
export function attachWs(server, onConn) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    let conn = null
    try {
      conn = new WsConn(req, socket)
    } catch {
      socket.destroy()
      return
    }
    onConn(conn, req)
  })
}
