import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, Sparkles, Trophy, X, Zap } from 'lucide-react';
import { useApp, type Toast } from '@/stores/app';
import { cn } from '@/lib/utils';
import { ACHIEVEMENT_MAP } from '@/lib/achievements';

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: AlertTriangle,
  xp: Zap,
  achievement: Trophy,
};

const TONES = {
  info: 'border-cyan/30 text-cyan',
  success: 'border-emerald/30 text-emerald',
  warn: 'border-amber/30 text-amber',
  error: 'border-rose/35 text-rose',
  xp: 'border-violet/35 text-violet',
  achievement: 'border-amber/40 text-amber',
};

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-200 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-5"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const Icon = ICONS[toast.kind] || Info;
  const isBig = toast.kind === 'achievement' || toast.kind === 'xp';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 22, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96, transition: { duration: 0.18 } }}
      transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'glass-strong pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-3.5 py-3',
        TONES[toast.kind],
        isBig && 'shadow-[0_18px_50px_-20px_rgba(0,0,0,0.95)]',
      )}
    >
      <div className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border bg-white/6', TONES[toast.kind])}>
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-snug text-fg">{toast.title}</div>
        {toast.desc && <div className="mt-0.5 text-[12px] leading-snug text-fg-mute">{toast.desc}</div>}
      </div>
      <button
        onClick={onClose}
        aria-label="关闭提示"
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-faint transition-colors hover:bg-white/8 hover:text-fg-soft"
      >
        <X size={13} />
      </button>
    </motion.div>
  );
}

/* 成就解锁的专用提示（比普通 toast 更有仪式感） */
export function announceAchievements(ids: string[], push: (t: Omit<Toast, 'id'>) => void) {
  ids.forEach((id, i) => {
    const a = ACHIEVEMENT_MAP[id];
    if (!a) return;
    setTimeout(() => {
      push({
        kind: 'achievement',
        title: `成就解锁 · ${a.name}`,
        desc: a.desc,
        ttl: 5200,
      });
    }, i * 420);
  });
}

export { Sparkles };
