import { useMemo, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, ArrowRight, Lock, Mail, User } from 'lucide-react';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Button, Input } from '@/components/ui/Primitives';
import { AppLink as Link } from '@/lib/links';
import { useAuth } from '@/stores/auth';
import { ApiError } from '@/lib/api';
import { useRegistrationOpen } from '@/lib/siteConfig';
import { cn } from '@/lib/utils';

/* 密码强度：与服务端 checkPasswordStrength 的口径保持一致，
 * 前端提前告知，别让用户填完提交才被拒。 */
interface Strength {
  score: number;
  label: string;
  cls: string;
  bar: string;
  w: number;
}

function strengthOf(pwd: string): Strength {
  if (!pwd) return { score: 0, label: '', cls: '', bar: 'bg-veil/12', w: 0 };
  let score = 0;
  if (pwd.length >= 8) score += 1;
  if (pwd.length >= 12) score += 1;
  if (/[a-zA-Z]/.test(pwd) && /\d/.test(pwd)) score += 1;
  if (/[^a-zA-Z0-9]/.test(pwd)) score += 1;

  const map = [
    { label: '太短', cls: 'text-rose', bar: 'bg-rose', w: 20 },
    { label: '偏弱', cls: 'text-amber', bar: 'bg-amber', w: 40 },
    { label: '一般', cls: 'text-amber', bar: 'bg-amber', w: 60 },
    { label: '不错', cls: 'text-emerald', bar: 'bg-emerald', w: 80 },
    { label: '很强', cls: 'text-emerald', bar: 'bg-emerald', w: 100 },
  ];
  const idx = Math.min(4, Math.max(0, score - (pwd.length < 8 ? 1 : 0)));
  return { score, ...map[idx] };
}

export default function Register() {
  const register = useAuth((s) => s.register);
  const registrationOpen = useRegistrationOpen();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);

  const strength = useMemo(() => strengthOf(password), [password]);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !!(email && username && password.length >= 8 && password === confirm);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;

    if (password !== confirm) {
      setError('两次输入的密码不一致');
      setShake((n) => n + 1);
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      setShake((n) => n + 1);
      return;
    }

    setError('');
    setLoading(true);
    try {
      await register(email.trim(), username.trim(), password);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '注册失败，请重试';
      setError(msg);
      setShake((n) => n + 1);
      setLoading(false);
    }
  };

  /* 注册关掉时整张表都不渲染。
   * 显示表单再让提交失败，会让人以为是自己填错了 —— 而这件事
   * 他无论怎么填都改不了。说清楚比让人反复试要体面。 */
  if (!registrationOpen) {
    return (
      <AuthLayout mode="register">
        <div className="mb-6">
          <h2 className="text-[21px] font-semibold tracking-tight text-fg">本站已关闭注册</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-fg-mute">
            这是一个私人学习系统，账号由管理员开通。
            需要账号请联系站点管理员，或者在管理台里直接建一个。
          </p>
        </div>

        <div className="mt-6 text-center text-[13px] text-fg-mute">
          已经有账号了？
          <Link to="/login" className="ml-1.5 font-medium text-cyan transition-colors hover:text-cyan-200">
            直接登录
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout mode="register">
      <div className="mb-6">
        <h2 className="text-[21px] font-semibold tracking-tight text-fg">创建账号</h2>
        <p className="mt-1.5 text-[13px] text-fg-mute">从今天开始，每天 30 分钟</p>
      </div>

      <form onSubmit={submit} className="space-y-4" key={shake}>
        <motion.div
          animate={shake > 0 ? { x: [0, -8, 7, -5, 3, 0] } : {}}
          transition={{ duration: 0.42 }}
          className="space-y-4"
        >
          <Input
            label="邮箱"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            icon={<Mail size={15} />}
          />

          <Input
            label="昵称"
            name="username"
            autoComplete="nickname"
            required
            maxLength={24}
            placeholder="怎么称呼你"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            icon={<User size={15} />}
          />

          <div>
            <Input
              label="密码"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              placeholder="至少 8 位，别用纯数字"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              icon={<Lock size={15} />}
            />
            {password && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-veil/8">
                  <div
                    className={cn('h-full rounded-full transition-all duration-400', strength.bar)}
                    style={{ width: `${strength.w}%` }}
                  />
                </div>
                <span className={cn('text-[11px] font-medium', strength.cls)}>{strength.label}</span>
              </div>
            )}
          </div>

          <Input
            label="确认密码"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            placeholder="再输一次"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            icon={<Lock size={15} />}
            error={mismatch ? '两次输入的密码不一致' : undefined}
          />
        </motion.div>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-start gap-2 rounded-xl border border-rose/30 bg-rose/10 px-3 py-2.5"
            role="alert"
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose" />
            <span className="text-[12.5px] leading-relaxed text-rose-100/90">{error}</span>
          </motion.div>
        )}

        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={loading}
          disabled={!canSubmit}
          shimmer={canSubmit}
        >
          {loading ? '正在创建' : '创建账号'}
          {!loading && <ArrowRight size={16} />}
        </Button>
      </form>

      <div className="mt-6 text-center text-[13px] text-fg-mute">
        已经有账号了？
        <Link to="/login" className="ml-1.5 font-medium text-cyan transition-colors hover:text-cyan-200">
          直接登录
        </Link>
      </div>
    </AuthLayout>
  );
}
