/**
 * 单用户认证：一条密码，四种凭据。
 *
 *  - **会话 cookie**（`artworks_session`）：浏览器用；`POST /session` 用密码换，HMAC 签名，30 天。
 *  - **Bearer token**（`/api-tokens`）：AI agent / CLI / MCP 用，长期、可撤销、记 lastUsedAt。
 *    只存哈希 —— 明文只在签发那一次出现。
 *  - **自认证链接 token**（`?t=`）：给「把图片 URL 交给自己的图像加载器」的客户端用
 *    （带不上自定义 header）。签发 API token 时一并给出（`linkToken`），签名里绑定那条 token 的
 *    id：撤销 API token = 链接立刻失效；范围只有读缩略图（`/thumb`）。
 *  - **任务范围 token**（同样走 `?t=`）：批注任务签发给外部批注人，载荷绑定任务 id、批注人
 *    与**签发它的 API token id**（`-` = 从会话/免认证签发，没有可撤销的 token）。撤销模型两条：
 *    签发它的 API token 一撤销就失效（与 linkToken 同一套），任务本身被取消/删掉也失效（任务层判）。
 *    范围只有「该任务 items 里的缩略图」与「POST /jobs/{id}/inbound」，回流记 `by: 'link:<批注人>'`。
 *    两种 `?t=` 凭据按路由分开消费：缩略图路由认 linkToken 与范围 token，回流路由**只认范围 token**
 *    （缩略图链接是只读的，不能拿去写标注）。
 *
 * 签名密钥落在 `dataDir/secret`（0600）。密码为空 = 免认证，只在本机开发时这么用。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApiTokenMeta {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  scope: string;
}

/** 凭据种类：浏览器会话 / 长期 bearer / 自认证链接 / 任务范围链接 */
export type CredentialVia = 'session' | 'bearer' | 'link' | 'annotate';

export interface Identity {
  via: CredentialVia;
  token?: ApiTokenMeta;
  /** `via='annotate'`：任务范围 token 解析出的任务 id 与批注人 */
  jobId?: string;
  alias?: string;
}

interface ApiTokenRecord extends ApiTokenMeta {
  hash: string;
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LINK_TTL_MS = 30 * 24 * 3600 * 1000;
/** 批注链接的有效期：比会话短一点（要发给别人）；过期后重发一次任务即可 */
const RANGE_TTL_MS = 30 * 24 * 3600 * 1000;

export class Auth {
  private readonly dataDir: string;
  private readonly password: string;
  private readonly secret: Buffer;
  private readonly tokenFile: string;
  private tokens: ApiTokenRecord[] = [];
  /** 会话代数：cookie 带上签发时的代数，代数变了旧 cookie 全部失效（登出 / 密码变更） */
  private sessionGen = 0;

  constructor(dataDir: string, password: string) {
    this.dataDir = dataDir;
    this.password = password;
    mkdirSync(dataDir, { recursive: true });
    this.secret = this.loadSecret();
    this.tokenFile = join(dataDir, 'tokens.json');
    this.loadTokens();
    this.loadSessionState();
  }

  /**
   * `session-state.json`：{gen, pw}，pw 是密码的 HMAC 指纹（不存明文/裸哈希）。
   * 启动时发现密码与指纹不符（改了配置里的密码）→ 代数 +1，之前签发的 cookie 全部失效。
   */
  private loadSessionState(): void {
    const file = join(this.dataDir, 'session-state.json');
    const pw = createHmac('sha256', this.secret).update(`pw|${this.password}`).digest('base64url');
    let st: { gen?: number; pw?: string } = {};
    try { st = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 首次 */ }
    this.sessionGen = Number.isInteger(st.gen) ? Number(st.gen) : 0;
    if (st.pw !== pw) { if (st.pw !== undefined) this.sessionGen++; this.saveSessionState(pw); }
  }

  private saveSessionState(pw = createHmac('sha256', this.secret).update(`pw|${this.password}`).digest('base64url')): void {
    const file = join(this.dataDir, 'session-state.json');
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ gen: this.sessionGen, pw }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch { /* 只读数据目录：本次进程内仍生效 */ }
  }

  /** 吊销所有已签发的会话 cookie（登出调用；单用户应用，登出即全端登出） */
  revokeSessions(): void {
    this.sessionGen++;
    this.saveSessionState();
  }

  get enabled(): boolean {
    return this.password !== '';
  }

  /**
   * 认「谁在操作」。**不管认证开关都要调** —— 免认证模式只是不拦请求，
   * 来源照样要记（否则本地开发时 AI 的标注会被记成 `me`）。
   */
  identify(input: {
    cookie?: string | undefined;
    authorization?: string | undefined;
    /** 缩略图路由的自认证链接（`link|…`）：只读 */
    linkToken?: string | undefined;
    /** 任务回流路由的任务范围 token（`annotate|…`）：能读该任务缩略图 + 写回该任务 */
    rangeToken?: string | undefined;
  }): Identity | null {
    // 注意：checkSession 在免认证模式下恒为 true，所以这里要先看 enabled
    if (this.enabled && this.checkSession(input.cookie)) return { via: 'session' };
    const header = input.authorization ?? '';
    if (header.toLowerCase().startsWith('bearer ')) {
      const token = this.verifyToken(header.slice(7).trim());
      if (token) return { via: 'bearer', token };
    }
    // `?t=` 分两种：缩略图路由收 linkToken（只读），回流路由只收任务范围 token。
    // 调用方（server.ts）按路由把 `?t=` 填进对应的那个参数，所以一种凭据拿不到另一种路由的权限。
    if (input.linkToken && this.verifyLinkToken(input.linkToken)) return { via: 'link' };
    if (input.rangeToken) {
      const range = this.verifyRangeToken(input.rangeToken);
      if (range) return { via: 'annotate', jobId: range.jobId, alias: range.alias };
    }
    return null;
  }

  private loadSecret(): Buffer {
    const file = join(this.dataDir, 'secret');
    if (existsSync(file)) {
      try {
        const buf = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
        if (buf.length >= 16) return buf;
      } catch {
        // 读不动就重新生成（会让旧 cookie / 旧链接失效，但比起不来强）
      }
    }
    const fresh = randomBytes(32);
    try {
      writeFileSync(file, fresh.toString('base64'), { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      // 写不进去（只读数据目录）也能跑：这次的密钥只在内存里
    }
    return fresh;
  }

  // ── 密码 / 会话 ─────────────────────────────────────────────────────────

  checkPassword(input: string): boolean {
    if (!this.enabled) return true;
    const a = Buffer.from(input, 'utf8');
    const b = Buffer.from(this.password, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  sessionCookie(): string {
    return this.sign(`session|${Date.now() + SESSION_TTL_MS}|${this.sessionGen}`);
  }

  checkSession(value: string | undefined | null): boolean {
    if (!this.enabled) return true;
    const payload = this.verify(value);
    if (!payload) return false;
    const [kind, exp, gen] = payload.split('|');
    return kind === 'session' && Number(exp) > Date.now() && gen !== undefined && Number(gen) === this.sessionGen;
  }

  // ── 自认证链接 token（缩略图 `?t=`）──────────────────────────────

  /**
   * 把某条 API token 的「只读预览」权限签进 URL 里：图像加载器带不上 header 时用
   * `/photos/{id}/thumb?size=…&t=<linkToken>`。签名里只有 tokenId + 过期时间，不带照片 id
   * —— 一个 token 管一批缩略图；对应的 API token 一撤销，它立刻失效。
   */
  issueLinkToken(tokenId: string, ttlMs = LINK_TTL_MS): { token: string; expiresAt: string } {
    const exp = Date.now() + ttlMs;
    return { token: this.sign(`link|${tokenId}|${exp}`), expiresAt: new Date(exp).toISOString() };
  }

  verifyLinkToken(token: string | undefined | null): { tokenId: string } | null {
    const payload = this.verify(token);
    if (!payload) return null;
    const [kind, tokenId, exp] = payload.split('|');
    if (kind !== 'link' || !tokenId || !(Number(exp) > Date.now())) return null;
    // 撤销即失效：tokens.json 是唯一事实来源
    return this.tokens.some((t) => t.id === tokenId) ? { tokenId } : null;
  }

  // ── 任务范围 token（批注链接 `?t=`）──────────────────────────────

  /**
   * 给一个任务签发「范围受限的批注链接」：载荷 `annotate|<jobId>|<alias>|<exp>|<tokenId>`。
   * 第 3 段是分发时填的批注人（回流记 `by: link:<alias>`），签名里绑 jobId —— 链接只能读
   * 这个任务 items 里的缩略图、只能往这个任务回流。`tokenId` = 签发这条链接的 API token
   * （会话/免认证签发时给 `-`）：撤销那条 token，链接立刻失效；任务被撤销/删掉也失效。
   */
  issueRangeToken(jobId: string, alias: string, tokenId?: string | null, ttlMs = RANGE_TTL_MS): { token: string; expiresAt: string } {
    const exp = Date.now() + ttlMs;
    return { token: this.sign(`annotate|${jobId}|${alias}|${exp}|${tokenId ?? '-'}`), expiresAt: new Date(exp).toISOString() };
  }

  /** 验签名、有效期与「签发它的 API token 还在不在」；「任务还在不在」由调用方（任务层）判 */
  verifyRangeToken(token: string | undefined | null): { jobId: string; alias: string } | null {
    const payload = this.verify(token);
    if (!payload) return null;
    const [kind, jobId, alias, exp, tokenId] = payload.split('|');
    if (kind !== 'annotate' || !jobId || !alias || !(Number(exp) > Date.now())) return null;
    // 撤销即失效：签它的时候如果用了某条 API token，那条 token 必须还在（`-` = 没绑）
    if (tokenId && tokenId !== '-' && !this.tokens.some((t) => t.id === tokenId)) return null;
    return { jobId, alias };
  }

  // ── API token ──────────────────────────────────────────────────────────

  issueToken(label: string, scope = 'full'): { token: string; meta: ApiTokenMeta } {
    const token = `aw_${randomBytes(24).toString('base64url')}`;
    const meta: ApiTokenMeta = {
      id: randomBytes(6).toString('base64url'),
      label: label || '未命名',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      scope,
    };
    this.tokens.push({ ...meta, hash: hashToken(token) });
    this.saveTokens();
    return { token, meta };
  }

  verifyToken(token: string | undefined | null): ApiTokenMeta | null {
    if (!token) return null;
    const hash = hashToken(token);
    const rec = this.tokens.find((t) => t.hash === hash);
    if (!rec) return null;
    // lastUsedAt 不必每次落盘（一分钟内的重复访问只记一次）
    const now = Date.now();
    if (!rec.lastUsedAt || now - Date.parse(rec.lastUsedAt) > 60_000) {
      rec.lastUsedAt = new Date(now).toISOString();
      this.saveTokens();
    }
    return { id: rec.id, label: rec.label, createdAt: rec.createdAt, lastUsedAt: rec.lastUsedAt, scope: rec.scope };
  }

  listTokens(): ApiTokenMeta[] {
    return this.tokens.map(({ hash: _hash, ...meta }) => meta);
  }

  revokeToken(id: string): boolean {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length !== before) {
      this.saveTokens();
      return true;
    }
    return false;
  }

  private loadTokens(): void {
    if (!existsSync(this.tokenFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.tokenFile, 'utf8')) as ApiTokenRecord[];
      if (Array.isArray(raw)) this.tokens = raw.filter((t) => t && typeof t.hash === 'string');
    } catch {
      // 坏了就当没签发过：重新签发一个即可
    }
  }

  private saveTokens(): void {
    try {
      writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
    } catch {
      // 写不动就只在内存里生效
    }
  }

  // ── 签名原语 ───────────────────────────────────────────────────────────

  private sign(payload: string): string {
    const body = Buffer.from(payload, 'utf8').toString('base64url');
    return `${body}.${this.hmac(body)}`;
  }

  private verify(value: string | undefined | null): string | null {
    if (!value) return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = this.hmac(body);
    // 先比 Buffer 的**字节**长度：字符串长度相同但字节长度不同时 timingSafeEqual 会抛 RangeError
    // （那会把一个坏签名变成 500，而不是干净的 401）
    const got = Buffer.from(sig);
    const want = Buffer.from(expected);
    if (got.length !== want.length) return null;
    if (!timingSafeEqual(got, want)) return null;
    try {
      return Buffer.from(body, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  private hmac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
