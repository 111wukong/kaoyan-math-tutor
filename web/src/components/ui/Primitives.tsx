import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/* ============ 玻璃面板 ============ */
export function Panel({
  children,
  className,
  variant = 'default',
  spotlight = false,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'strong' | 'subtle';
  spotlight?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  const base = variant === 'strong' ? 'glass-strong' : variant === 'subtle' ? 'glass-subtle' : 'glass';
  return (
    <div
      className={cn(
        base,
        'relative rounded-2xl',
        spotlight && 'spotlight',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ============ 按钮 ============ */
type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'success' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'text-on-accent font-semibold bg-gradient-to-r from-cyan to-blue hover:from-cyan hover:to-violet glow-cyan',
  success:
    'text-on-accent font-semibold bg-gradient-to-r from-emerald to-cyan glow-emerald',
  danger:
    'text-white font-medium bg-gradient-to-r from-rose/90 to-magenta/80 hover:from-rose hover:to-magenta glow-rose',
  outline:
    'text-fg border border-hairline-strong bg-veil/4 hover:bg-veil/8 hover:border-cyan/40',
  ghost:
    'text-fg-soft hover:text-fg hover:bg-veil/6',
  subtle:
    'text-fg-soft bg-veil/5 hover:bg-veil/9 border border-veil/8',
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-xl',
  icon: 'h-9 w-9 rounded-lg justify-center',
};

export const Button = forwardRef<HTMLButtonElement, {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  shimmer?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { children, className, variant = 'primary', size = 'md', loading, shimmer, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap transition-all duration-200',
        'active:scale-[0.975] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100',
        BTN_VARIANT[variant],
        BTN_SIZE[size],
        shimmer && !disabled && 'shimmer',
        className,
      )}
      {...rest}
    >
      {loading && (
        <span className="mr-1 inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
});

/* ============ 输入 ============ */
export const Input = forwardRef<HTMLInputElement, {
  label?: string;
  hint?: string;
  error?: string;
  icon?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, label, hint, error, icon, id, ...rest },
  ref,
) {
  const inputId = id || rest.name || Math.random().toString(36).slice(2, 8);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-[12.5px] font-medium text-fg-soft">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'h-11 w-full rounded-xl border bg-veil/4 px-3.5 text-sm text-fg outline-none transition-all duration-200',
            'placeholder:text-fg-faint',
            'focus:border-cyan/50 focus:bg-veil/6 focus:halo-cyan',
            error ? 'border-rose/55' : 'border-hairline',
            icon ? 'pl-10' : null,
            className,
          )}
          {...rest}
        />
      </div>
      {error ? (
        <p className="mt-1.5 text-[12px] text-rose">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-[12px] text-fg-mute">{hint}</p>
      ) : null}
    </div>
  );
});

export const TextArea = forwardRef<HTMLTextAreaElement, {
  label?: string;
  hint?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, label, hint, id, ...rest },
  ref,
) {
  const areaId = id || rest.name || Math.random().toString(36).slice(2, 8);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={areaId} className="mb-1.5 block text-[12.5px] font-medium text-fg-soft">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={areaId}
        className={cn(
          'w-full resize-y rounded-xl border border-hairline bg-veil/4 px-3.5 py-2.5 text-sm text-fg outline-none transition-all duration-200',
          'placeholder:text-fg-faint focus:border-cyan/50 focus:bg-veil/6 focus:halo-cyan',
          className,
        )}
        {...rest}
      />
      {hint && <p className="mt-1.5 text-[12px] text-fg-mute">{hint}</p>}
    </div>
  );
});

/* ============ 徽章 ============ */
export function Badge({
  children,
  className,
  tone = 'neutral',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'neutral' | 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose';
}) {
  const tones = {
    neutral: 'text-fg-soft border-veil/10 bg-veil/5',
    cyan: 'text-cyan-200/95 border-cyan-400/25 bg-cyan-400/10',
    violet: 'text-violet-200/95 border-violet-400/25 bg-violet-400/10',
    emerald: 'text-emerald-200/95 border-emerald-400/25 bg-emerald-400/10',
    amber: 'text-amber-200/95 border-amber-400/25 bg-amber-400/10',
    rose: 'text-rose-200/95 border-rose-400/25 bg-rose-400/10',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-[3px] text-[11.5px] font-medium leading-none',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ============ 分段控件 ============ */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={cn('inline-flex rounded-xl border border-hairline bg-veil/4 p-0.5', className)} role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative rounded-[10px] font-medium transition-all duration-250',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]',
              active
                ? 'bg-gradient-to-r from-cyan/22 to-violet/18 text-fg shadow-[0_1px_0_var(--glass-edge)_inset]'
                : 'text-fg-mute hover:text-fg-soft',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============ 骨架屏 ============ */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg', className)} />;
}

/* ============ 空状态 ============ */
export function EmptyState({
  icon,
  title,
  desc,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="float mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-hairline bg-veil/4 text-fg-mute">
          {icon}
        </div>
      )}
      <h3 className="text-[15px] font-medium text-fg-soft">{title}</h3>
      {desc && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-mute">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ============ 统计卡 ============ */
export function StatCard({
  label,
  value,
  sub,
  icon,
  accent = 'cyan',
  delay = 0,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  accent?: 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' | 'blue';
  delay?: number;
  className?: string;
}) {
  const accents = {
    cyan: 'from-cyan/18 text-cyan',
    violet: 'from-violet/18 text-violet',
    emerald: 'from-emerald/18 text-emerald',
    amber: 'from-amber/18 text-amber',
    rose: 'from-rose/18 text-rose',
    blue: 'from-blue/18 text-blue',
  };
  return (
    <Panel
      className={cn('rise-in group overflow-hidden p-4 transition-colors duration-300 hover:border-veil/16', className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={cn('pointer-events-none absolute inset-x-0 -top-16 h-32 bg-gradient-to-b to-transparent opacity-60 blur-2xl', accents[accent].split(' ')[0])} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium tracking-wide text-fg-mute">{label}</div>
          <div className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight text-fg">{value}</div>
          {sub && <div className="mt-2 text-[12px] leading-snug text-fg-mute">{sub}</div>}
        </div>
        {icon && (
          <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-veil/8 bg-veil/5', accents[accent].split(' ')[1])}>
            {icon}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ============ 区块标题 ============ */
export function SectionTitle({
  title,
  desc,
  right,
  className,
}: {
  title: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-end justify-between gap-4', className)}>
      <div>
        <h2 className="text-[16px] font-semibold tracking-tight text-fg">{title}</h2>
        {desc && <p className="mt-1 text-[12.5px] leading-relaxed text-fg-mute">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

/* ============ 分隔线 ============ */
export function Divider({ className, label }: { className?: string; label?: string }) {
  if (!label) return <div className={cn('h-px w-full bg-hairline', className)} />;
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div className="h-px flex-1 bg-hairline" />
      <span className="text-[11.5px] text-fg-faint">{label}</span>
      <div className="h-px flex-1 bg-hairline" />
    </div>
  );
}
