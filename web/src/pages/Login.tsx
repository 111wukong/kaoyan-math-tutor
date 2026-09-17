import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { AlertCircle, ArrowRight, Mail, Lock } from 'lucide-react';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Button, Input } from '@/components/ui/Primitives';
import { useAuth } from '@/stores/auth';
import { ApiError } from '@/lib/api';

export default function Login() {
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      await login(email.trim(), password);
      // 成功后 App 会自动切到主界面，这里不需要跳转
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '登录失败，请重试';
      setError(msg);
      setShake((n) => n + 1);
      setLoading(false);
    }
  };

  return (
    <AuthLayout mode="login">
      <div className="mb-6">
        <h2 className="text-[21px] font-semibold tracking-tight text-fg">欢迎回来</h2>
        <p className="mt-1.5 text-[13px] text-fg-mute">继续你的考研数学进度</p>
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
            label="密码"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            icon={<Lock size={15} />}
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

        <Button type="submit" size="lg" className="w-full" loading={loading} shimmer>
          {loading ? '正在登录' : '登录'}
          {!loading && <ArrowRight size={16} />}
        </Button>
      </form>

      <div className="mt-6 text-center text-[13px] text-fg-mute">
        还没有账号？
        <Link to="/register" className="ml-1.5 font-medium text-cyan transition-colors hover:text-cyan-200">
          注册一个
        </Link>
      </div>
    </AuthLayout>
  );
}
