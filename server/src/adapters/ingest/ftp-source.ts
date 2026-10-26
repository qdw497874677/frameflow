/**
 * 入站适配器：最小的「只上传」FTP / FTPES 服务（相机直传用，例如索尼「FTP 传输」）。
 *
 * 为什么自己写：只需要相机用到的那一小撮命令；第三方 FTP 服务库要么久不维护、带已知漏洞依赖，
 * 要么连带一大串运行时依赖。攻击面越小越好 —— 这里**没有下载、删除、改名**。
 *
 * - 认证：单一用户名 + 密码文件（常数时间比较），按来源 IP 失败限流；
 * - 显式 TLS（AUTH TLS，索尼只支持这种）；配了证书默认强制加密；PROT P 时数据连接同样加密；
 * - 被动模式（PASV/EPSV），端口范围与对外地址可配（Tailscale 100.x / 局域网 IP）；
 * - chroot：登录时把「今天的收件目录」当作 `/`，任何路径都解析在它里面，`..` 越界、点开头的段一律拒绝；
 * - 上传先写 `.名字.ffpart`，传完再改名 —— 半截文件永远不会被当成照片；同名已存在时另起名字，绝不覆盖原片。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { posix, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import tls from 'node:tls';
import { isPartialName } from '../../domain/ingest/arrival.ts';
import type { IngestSink, IngestSource } from '../../application/ingest/ports.ts';
import type { IngestFtpCfg } from '../outbound/config-file.ts';

const MAX_SESSIONS = 16;
const IDLE_MS = 5 * 60_000;
const DATA_WAIT_MS = 30_000;
const FAIL_LIMIT = 5;
const FAIL_LOCK_MS = 60_000;

export interface FtpSourceDeps {
  readonly rootId: string;
  readonly rootPath: string;
  /** 今天的收件目录（相对根目录，POSIX） */
  readonly inboxRel: () => string;
  readonly log?: (text: string) => void;
}

type Sock = net.Socket | tls.TLSSocket;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class FtpIngestSource implements IngestSource {
  readonly kind = 'ftp' as const;
  private server: net.Server | null = null;
  private readonly sessions = new Set<FtpSession>();
  private secure: tls.SecureContext | null = null;
  private passHash: Buffer | null = null;
  private readonly fails = new Map<string, { n: number; until: number }>();
  private nextPasv: number;
  uploads = 0;
  lastUpload: string | null = null;
  lastError: string | null = null;
  readonly cfg: IngestFtpCfg;
  readonly deps: FtpSourceDeps;
  sink: IngestSink | null = null;

  constructor(cfg: IngestFtpCfg, deps: FtpSourceDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.nextPasv = cfg.pasvMin;
  }

  get tlsContext(): tls.SecureContext | null {
    return this.secure;
  }

  async start(sink: IngestSink): Promise<void> {
    this.sink = sink;
    const pass = readFileSync(this.cfg.passwordFile, 'utf8').split(/\r?\n/)[0] ?? '';
    if (pass.length < 8) throw new Error('ingest.ftp.passwordFile：密码至少 8 位');
    this.passHash = digest(pass);
    if (this.cfg.tls) {
      if (!existsSync(this.cfg.tls.cert) || !existsSync(this.cfg.tls.key)) throw new Error('ingest.ftp.tls：证书或私钥文件不存在');
      this.secure = tls.createSecureContext({ cert: readFileSync(this.cfg.tls.cert), key: readFileSync(this.cfg.tls.key), minVersion: 'TLSv1.2' });
    }
    const server = net.createServer((sock) => {
      if (this.sessions.size >= MAX_SESSIONS) {
        sock.end('421 连接太多，稍后再试\r\n');
        return;
      }
      const s = new FtpSession(this, sock);
      this.sessions.add(s);
      sock.once('close', () => this.sessions.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, this.cfg.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions) s.destroy();
    this.sessions.clear();
    const srv = this.server;
    this.server = null;
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }

  /** 实际监听的端口（配置 0 时由系统分配） */
  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.cfg.port;
  }

  status(): Record<string, unknown> {
    return {
      running: this.server !== null,
      host: this.cfg.host,
      port: this.port,
      pasv: `${this.cfg.pasvMin}-${this.cfg.pasvMax}`,
      pasvUrl: this.cfg.pasvUrl || null,
      user: this.cfg.user,
      tls: this.secure !== null,
      requireTls: this.secure !== null && this.cfg.requireTls,
      sessions: this.sessions.size,
      uploads: this.uploads,
      lastUpload: this.lastUpload,
      lastError: this.lastError,
    };
  }

  // ── 给会话用的 ──────────────────────────────────────────────────────────
  lockedFor(ip: string): number {
    const f = this.fails.get(ip);
    return f && f.until > Date.now() ? f.until - Date.now() : 0;
  }

  checkLogin(ip: string, user: string, pass: string): boolean {
    const ok = this.passHash !== null && user === this.cfg.user && timingSafeEqual(digest(pass), this.passHash);
    if (ok) {
      this.fails.delete(ip);
      return true;
    }
    const f = this.fails.get(ip) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= FAIL_LIMIT) {
      f.until = Date.now() + FAIL_LOCK_MS;
      f.n = 0;
    }
    this.fails.set(ip, f);
    return false;
  }

  /** 在被动端口范围里找一个能监听的 */
  async listenPassive(): Promise<net.Server> {
    const span = this.cfg.pasvMax - this.cfg.pasvMin + 1;
    for (let i = 0; i < span; i++) {
      const port = this.nextPasv;
      this.nextPasv = port >= this.cfg.pasvMax ? this.cfg.pasvMin : port + 1;
      const srv = net.createServer();
      const ok = await new Promise<boolean>((resolve) => {
        srv.once('error', () => resolve(false));
        srv.listen(port, this.cfg.host, () => resolve(true));
      });
      if (ok) return srv;
    }
    throw new Error('被动端口都被占了');
  }

  uploaded(relDir: string, name: string): void {
    this.uploads++;
    this.lastUpload = new Date().toISOString();
    this.sink?.arrived({ rootId: this.deps.rootId, relDir, name, complete: true });
  }
}

class FtpSession {
  private sock: Sock;
  private buf = '';
  private user: string | null = null;
  private authed = false;
  private secured = false;
  private protP = false;
  /** chroot 的真实目录（相对根目录），登录时定下 */
  private jailRel = '';
  private cwd = '/';
  private pasv: net.Server | null = null;
  private dataSock: Promise<Sock> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private busy = false;
  private queue: string[] = [];
  private readonly ip: string;
  private readonly src: FtpIngestSource;

  constructor(src: FtpIngestSource, sock: net.Socket) {
    this.src = src;
    this.sock = sock;
    this.ip = sock.remoteAddress ?? '?';
    this.attach(sock);
    this.reply(220, 'FrameFlow ingest FTP ready');
  }

  destroy(): void {
    this.closePasv();
    this.sock.destroy();
  }

  private attach(sock: Sock): void {
    const dec = new StringDecoder('utf8'); // 不 setEncoding：AUTH TLS 要把原始字节交给 TLS
    sock.on('data', (chunk: Buffer) => this.onData(dec.write(chunk)));
    sock.on('error', () => undefined);
    sock.on('close', () => this.closePasv());
    this.touch();
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.reply(421, '空闲太久，断开');
      this.destroy();
    }, IDLE_MS);
    this.idle.unref?.();
  }

  private reply(code: number, text: string): void {
    if (!this.sock.destroyed) this.sock.write(`${code} ${text}\r\n`);
  }

  private onData(chunk: string): void {
    this.touch();
    this.buf += chunk;
    if (this.buf.length > 8192) {
      this.reply(500, '命令太长');
      this.destroy();
      return;
    }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.queue.push(line);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const line = this.queue.shift()!;
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : line.slice(sp + 1);
        try {
          const upgraded = await this.handle(cmd, arg);
          if (upgraded) return; // AUTH TLS：剩下的字节属于 TLS 握手，交给新套接字
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.src.lastError = msg;
          this.reply(451, `出错了：${msg}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** 返回 true = 套接字已换成 TLS */
  private async handle(cmd: string, arg: string): Promise<boolean> {
    const needTls = this.src.tlsContext !== null && this.src.cfg.requireTls && !this.secured;
    switch (cmd) {
      case 'AUTH': {
        const ctx = this.src.tlsContext;
        if (!ctx || !/^(TLS|SSL|TLS-C)$/i.test(arg.trim())) {
          this.reply(504, '不支持这种加密');
          return false;
        }
        if (this.secured) {
          this.reply(503, '已经加密');
          return false;
        }
        this.reply(234, 'AUTH TLS 好的');
        const raw = this.sock as net.Socket;
        raw.removeAllListeners('data');
        raw.removeAllListeners('close');
        raw.pause();
        const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: ctx });
        this.sock = secure;
        this.secured = true;
        this.buf = '';
        this.queue = [];
        this.attach(secure);
        secure.on('close', () => raw.destroy());
        return true;
      }
      case 'PBSZ':
        this.reply(this.secured ? 200 : 503, this.secured ? 'PBSZ=0' : '先 AUTH TLS');
        return false;
      case 'PROT': {
        const p = arg.trim().toUpperCase();
        if (!this.secured) this.reply(503, '先 AUTH TLS');
        else if (p === 'P') { this.protP = true; this.reply(200, '数据连接加密'); }
        else if (p === 'C' && !this.src.cfg.requireTls) { this.protP = false; this.reply(200, '数据连接明文'); }
        else this.reply(534, '只接受 PROT P');
        return false;
      }
      case 'USER':
        if (needTls) { this.reply(530, '请先 AUTH TLS（本服务要求加密）'); return false; }
        this.user = arg.trim();
        this.authed = false;
        this.reply(331, '请给密码');
        return false;
      case 'PASS': {
        if (needTls) { this.reply(530, '请先 AUTH TLS'); return false; }
        if (this.user === null) { this.reply(503, '先 USER'); return false; }
        const wait = this.src.lockedFor(this.ip);
        if (wait > 0) { this.reply(421, `失败太多，${Math.ceil(wait / 1000)} 秒后再试`); this.destroy(); return false; }
        if (!this.src.checkLogin(this.ip, this.user, arg)) {
          await new Promise((r) => setTimeout(r, 500));
          this.reply(530, '用户名或密码不对');
          return false;
        }
        this.authed = true;
        this.jailRel = this.src.deps.inboxRel();
        this.cwd = '/';
        await mkdir(this.abs('/'), { recursive: true });
        this.src.deps.log?.(`FTP 登录 ${this.ip}`);
        this.reply(230, '登录成功');
        return false;
      }
      case 'QUIT':
        this.reply(221, '再见');
        this.sock.end();
        return false;
      case 'NOOP':
        this.reply(200, 'OK');
        return false;
      case 'FEAT':
        this.sock.write(`211-Features:\r\n${this.src.tlsContext ? ' AUTH TLS\r\n PBSZ\r\n PROT\r\n' : ''} PASV\r\n EPSV\r\n SIZE\r\n UTF8\r\n211 End\r\n`);
        return false;
      case 'SYST':
        this.reply(215, 'UNIX Type: L8');
        return false;
      case 'OPTS':
        this.reply(/^UTF8 ON$/i.test(arg.trim()) ? 200 : 501, 'OK');
        return false;
    }
    if (!this.authed) {
      this.reply(530, '请先登录');
      return false;
    }
    switch (cmd) {
      case 'PWD':
      case 'XPWD':
        this.reply(257, `"${this.cwd.replace(/"/g, '""')}" 是当前目录`);
        return false;
      case 'CWD':
      case 'XCWD': {
        const v = this.virt(arg);
        const st = v ? await stat(this.abs(v)).catch(() => null) : null;
        if (!v || !st?.isDirectory()) { this.reply(550, '没这个目录'); return false; }
        this.cwd = v;
        this.reply(250, '好');
        return false;
      }
      case 'CDUP':
      case 'XCUP':
        this.cwd = posix.dirname(this.cwd);
        this.reply(250, '好');
        return false;
      case 'MKD':
      case 'XMKD': {
        const v = this.virt(arg);
        if (!v || v === '/') { this.reply(550, '不能建这个目录'); return false; }
        await mkdir(this.abs(v), { recursive: true });
        this.reply(257, `"${v}" 已建`);
        return false;
      }
      case 'TYPE':
        this.reply(/^(I|A|L 8)/i.test(arg.trim()) ? 200 : 504, 'OK');
        return false;
      case 'MODE':
        this.reply(arg.trim().toUpperCase() === 'S' ? 200 : 504, 'OK');
        return false;
      case 'STRU':
        this.reply(arg.trim().toUpperCase() === 'F' ? 200 : 504, 'OK');
        return false;
      case 'PASV':
      case 'EPSV': {
        await this.openPasv();
        const port = (this.pasv!.address() as net.AddressInfo).port;
        if (cmd === 'EPSV') this.reply(229, `进入扩展被动模式 (|||${port}|)`);
        else {
          const host = (this.src.cfg.pasvUrl || (this.sock.localAddress ?? '127.0.0.1')).replace(/^::ffff:/, '');
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) { this.reply(425, 'PASV 只支持 IPv4，请用 EPSV 或配置 pasvUrl'); return false; }
          this.reply(227, `进入被动模式 (${host.replace(/\./g, ',')},${port >> 8},${port & 255})`);
        }
        return false;
      }
      case 'SIZE': {
        const v = this.virt(arg);
        const st = v ? await stat(this.abs(v)).catch(() => null) : null;
        if (!st?.isFile()) this.reply(550, '没这个文件');
        else this.reply(213, String(st.size));
        return false;
      }
      case 'LIST':
      case 'NLST': {
        const names = await readdir(this.abs(this.cwd)).catch(() => [] as string[]);
        await this.withData(async (data) => {
          const visible = names.filter((n) => !n.startsWith('.'));
          data.end(visible.map((n) => `${n}\r\n`).join(''));
          await new Promise((r) => data.once('close', r));
        });
        return false;
      }
      case 'STOR':
        await this.stor(arg);
        return false;
      case 'RETR':
      case 'DELE':
      case 'RMD':
      case 'XRMD':
      case 'RNFR':
      case 'RNTO':
      case 'APPE':
      case 'SITE':
        this.reply(550, '本服务只收上传');
        return false;
      default:
        this.reply(502, '不支持的命令');
        return false;
    }
  }

  /** 虚拟路径（chroot 内，POSIX，以 / 开头）；越界或含点开头段 → null */
  private virt(arg: string): string | null {
    const raw = arg.trim().replace(/\\/g, '/');
    if (!raw || raw.includes('\0')) return raw ? null : this.cwd;
    const segs: string[] = [];
    for (const seg of (raw.startsWith('/') ? raw : `${this.cwd}/${raw}`).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (!segs.length) return null;
        segs.pop();
        continue;
      }
      if (seg.startsWith('.') || seg.length > 255) return null;
      segs.push(seg);
    }
    return `/${segs.join('/')}`;
  }

  private relDirOf(v: string): string {
    return [this.jailRel, ...v.split('/').filter(Boolean)].filter(Boolean).join('/');
  }

  private abs(v: string): string {
    return join(this.src.deps.rootPath, ...this.relDirOf(v).split('/').filter(Boolean));
  }

  private closePasv(): void {
    this.pasv?.close();
    this.pasv = null;
    this.dataSock = null;
  }

  private async openPasv(): Promise<void> {
    this.closePasv();
    const srv = await this.src.listenPassive();
    this.pasv = srv;
    const ctx = this.src.tlsContext;
    this.dataSock = new Promise<Sock>((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('数据连接没来')); srv.close(); }, DATA_WAIT_MS);
      t.unref?.();
      srv.once('connection', (sock) => {
        clearTimeout(t);
        srv.close();
        // 只接受控制连接同一来源的数据连接（防 FTP bounce / 抢连接）
        if (norm(sock.remoteAddress) !== norm(this.ip)) {
          sock.destroy();
          reject(new Error('数据连接来源不对'));
          return;
        }
        if (this.protP && ctx) {
          const secure = new tls.TLSSocket(sock, { isServer: true, secureContext: ctx });
          secure.once('secure', () => resolve(secure));
          secure.once('error', reject);
        } else resolve(sock);
      });
    });
    this.dataSock.catch(() => undefined);
  }

  private async withData(fn: (data: Sock) => Promise<void>): Promise<void> {
    if (!this.dataSock) { this.reply(425, '先 PASV/EPSV'); return; }
    if (this.src.tlsContext && this.src.cfg.requireTls && !this.protP) { this.reply(521, '数据连接必须加密（PROT P）'); this.closePasv(); return; }
    const pending = this.dataSock;
    this.dataSock = null;
    this.reply(150, '开始传输');
    let data: Sock;
    try {
      data = await pending;
    } catch (err) {
      this.reply(425, `数据连接失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      this.pasv = null;
    }
    try {
      await fn(data);
      this.reply(226, '传输完成');
    } catch (err) {
      data.destroy();
      this.reply(426, `传输中断：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async stor(arg: string): Promise<void> {
    const v = this.virt(arg);
    const name = v ? posix.basename(v) : '';
    if (!v || v === '/' || isPartialName(name)) { this.reply(553, '文件名不行'); this.closePasv(); return; }
    const dirV = posix.dirname(v);
    const dirAbs = this.abs(dirV);
    const st = await stat(dirAbs).catch(() => null);
    if (!st?.isDirectory()) { this.reply(550, '目录不存在（先 MKD）'); this.closePasv(); return; }
    const tmp = join(dirAbs, `.${name}.ffpart`);
    let finalName = '';
    await this.withData(async (data) => {
      const out = createWriteStream(tmp, { flags: 'w' });
      try {
        await new Promise<void>((resolve, reject) => {
          let ended = false;
          data.on('end', () => { ended = true; });
          data.once('error', reject);
          out.once('error', reject);
          data.once('close', () => { if (!ended) reject(new Error('连接提前断开')); });
          out.once('finish', () => resolve());
          data.pipe(out);
        });
        finalName = await uniqueName(dirAbs, name);
        await rename(tmp, join(dirAbs, finalName));
      } catch (err) {
        out.destroy();
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
    });
    if (finalName) {
      this.src.deps.log?.(`FTP 收到 ${this.relDirOf(dirV)}/${finalName}`);
      this.src.uploaded(this.relDirOf(dirV), finalName);
    }
  }
}

const norm = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '');

/** 同名已存在 → `名字_1.JPG`、`名字_2.JPG`……（绝不覆盖原片） */
async function uniqueName(dir: string, name: string): Promise<string> {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10_000; i++) {
    const n = `${stem}_${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
  throw new Error('同名文件太多');
}
