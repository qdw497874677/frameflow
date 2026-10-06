import { useState } from 'react';
import { Aperture, Loader2, LogIn } from 'lucide-react';
import { store } from '@/core/store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 登录页：只在后端开了密码（`authRequired`）且还没换到会话时出现。
 * 家用 + Tailscale 的场景下这是唯一一道门 —— 密码对了换一个签名 cookie，之后不再问。
 */
export function LoginScreen() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await store.login(password);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="grid h-svh place-items-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-9 place-items-center rounded-lg bg-gold/15 text-gold">
            <Aperture className="size-4" />
          </div>
          <CardTitle>art-workspace</CardTitle>
          <CardDescription>挑片 · 回收站 —— 输入密码继续</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={submit}>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              aria-label="密码"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            {message && <p className="text-xs text-danger">{message}</p>}
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              进入
            </Button>
            <p className="text-[11px] text-muted-foreground">
              密码在后端 <code className="text-foreground">artworks.config.yaml</code> 的 <code className="text-foreground">password</code> 里；
              留空表示不启用认证。
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
