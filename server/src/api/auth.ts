/**
 * 单用户认证：一条密码，三种凭据。
 *
 *  - **会话 cookie**（`artworks_session`）：浏览器用；`POST /session` 用密码换，HMAC 签名，30 天。
 *  - **Bearer token**（`/api-tokens`）：AI agent / CLI / MCP 用，长期、可撤销、记 lastUsedAt。
 *    只存哈希 —— 明文只在签发那一次出现。
 *  - **自认证链接 token**（`?t=`）：给「把图片 URL 交给自己的图像加载器」的客户端用
 *    （带不上自定义 header），也用于范围受限的外部批注链接。同样是 HMAC 签名，带过期时间。
 *
 * 签名密钥落在 `dataDir/secret`（0600）。密码为空 = 免认证，只在本机开发时这么用。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApiTokenMeta {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  scope: string;
}

/** 凭据种类：浏览器会话 / 长期 bearer / 自认证链接 */
export type CredentialVia = 'session' | 'bearer' | 'link';

export interface Identity {
  via: CredentialVia;
  token?: ApiTokenMeta;
}

interface ApiTokenRecord extends ApiTokenMeta {
  hash: string;
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const THUMB_TTL_MS = 7 * 24 * 3600 * 1000;

export class Auth {
  private readonly dataDir: string;
  private readonly password: string;
  private readonly secret: Buffer;
  private readonly tokenFile: string;
  private tokens: ApiTokenRecord[] = [];

  constructor(dataDir: string, password: string) {
    this.dataDir = dataDir;
    this.password = password;
    mkdirSync(dataDir, { recursive: true });
    this.secret = this.loadSecret();
    this.tokenFile = join(dataDir, 'tokens.json');
    this.loadTokens();
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
    thumbToken?: string | undefined;
    photoId?: string | undefined;
  }): Identity | null {
    // 注意：checkSession 在免认证模式下恒为 true，所以这里要先看 enabled
    if (this.enabled && this.checkSession(input.cookie)) return { via: 'session' };
    const header = input.authorization ?? '';
    if (header.toLowerCase().startsWith('bearer ')) {
      const token = this.verifyToken(header.slice(7).trim());
      if (token) return { via: 'bearer', token };
    }
    if (input.thumbToken) {
      const link = this.verifyThumbToken(input.thumbToken);
      if (link && (!input.photoId || !link.photoId || link.photoId === input.photoId)) return { via: 'link' };
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
    return this.sign(`session|${Date.now() + SESSION_TTL_MS}`);
  }

  checkSession(value: string | undefined | null): boolean {
    if (!this.enabled) return true;
    const payload = this.verify(value);
    if (!payload) return false;
    const [kind, exp] = payload.split('|');
    return kind === 'session' && Number(exp) > Date.now();
  }

  // ── 自认证链接 token（缩略图 `?t=`、外部批注链接）────────────────────────

  thumbToken(photoId: string, size: number, ttlMs = THUMB_TTL_MS): string {
    return this.sign(`thumb|${photoId}|${size}|${Date.now() + ttlMs}`);
  }

  verifyThumbToken(token: string | undefined | null): { photoId: string; size?: number } | null {
    const payload = this.verify(token);
    if (!payload) return null;
    const [kind, photoId, size, exp] = payload.split('|');
    if (kind !== 'thumb' || !photoId || Number(exp) <= Date.now()) return null;
    return { photoId, size: size ? Number(size) : undefined };
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
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
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
