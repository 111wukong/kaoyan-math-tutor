import { Check, Moon, Sun } from 'lucide-react';
import { THEMES, type ThemeDef } from '@/lib/themes';
import { useTheme } from '@/stores/theme';
import { cn } from '@/lib/utils';

/* 主题选择器
 *
 * ── 为什么是"点了就生效"，不是"选完再点保存" ──────────────────────
 * 外观是所见即所得的。让人先选、再点保存、再看效果、不满意再回来 ——
 * 这个来回本身就是设计缺陷。所以这里直接调 setTheme：
 *   1. 立刻改 <html data-theme>（画面当场变）；
 *   2. 写 localStorage（刷新不丢）；
 *   3. 后台回写服务端（换设备跟着走），失败静默。
 *
 * ── 缩略图是"画"出来的，不是截图 ──────────────────────────────────
 * 用主题自己的色板拼一个小场景：底色 + 一张卡片 + 两条强调色。
 * 比纯色块信息量大（能看出明暗、能看出强调色的位置感），
 * 又不用为每个主题存一张图。
 */
export function ThemePicker() {
  const { id: activeId, setTheme } = useTheme();

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {THEMES.map((t) => (
        <ThemeCard
          key={t.id}
          theme={t}
          active={t.id === activeId}
          onPick={() => setTheme(t.id)}
        />
      ))}
    </div>
  );
}

function ThemeCard({ theme, active, onPick }: { theme: ThemeDef; active: boolean; onPick: () => void }) {
  const [bg, panel, a1, a2, fg] = theme.preview;
  const light = theme.mode === 'light';

  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      data-theme-id={theme.id}
      className={cn(
        'group relative overflow-hidden rounded-2xl border p-3 text-left transition-all duration-250',
        active
          ? 'border-cyan/55 bg-cyan/8 shadow-[0_0_0_1px_var(--color-cyan)]'
          : 'border-hairline bg-veil/3 hover:border-hairline-strong hover:bg-veil/6',
      )}
    >
      {/* 缩略图。位置一律走内联 style，不用 Tailwind 的间距类 ——
       * 这些是"画"出来的像素级位置，跟设计系统的间距刻度没关系，
       * 混用会让以后调刻度时误伤这里。 */}
      <div
        className="relative h-[62px] overflow-hidden rounded-xl"
        style={{ background: bg, boxShadow: `inset 0 0 0 1px ${fg}22` }}
      >
        {/* 一张"卡片" */}
        <div
          className="absolute rounded-md"
          style={{ left: 8, top: 8, width: '54%', height: 38, background: panel, border: `1px solid ${fg}1f` }}
        >
          <div className="absolute rounded-full" style={{ left: 6, top: 6, width: 24, height: 3, background: fg, opacity: 0.75 }} />
          <div className="absolute rounded-full" style={{ left: 6, top: 13, width: 36, height: 3, background: fg, opacity: 0.35 }} />
          <div className="absolute rounded-full" style={{ left: 6, top: 20, width: 20, height: 3, background: fg, opacity: 0.35 }} />
        </div>
        {/* 两条强调色，位置和真实界面里的"主按钮 + 进度条"对应 */}
        <div className="absolute rounded-full" style={{ left: 8, bottom: 8, width: '34%', height: 7, background: a1 }} />
        <div className="absolute rounded-full" style={{ left: '42%', bottom: 8, width: '16%', height: 7, background: a2 }} />
        {/* 右上角一枚小徽标，暗示"强调色也用在标签上" */}
        <div
          className="absolute rounded-full"
          style={{ right: 8, top: 8, width: 14, height: 14, background: `linear-gradient(135deg, ${a1}, ${a2})` }}
        />
      </div>

      <div className="mt-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {light
              ? <Sun size={12} className="shrink-0 text-amber" />
              : <Moon size={12} className="shrink-0 text-cyan" />}
            <span className="truncate text-[13px] font-medium text-fg">{theme.name}</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-mute">{theme.desc}</p>
        </div>
        <span
          className={cn(
            'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full transition-opacity',
            active ? 'bg-cyan text-on-accent opacity-100' : 'opacity-0',
          )}
        >
          <Check size={11} strokeWidth={3} />
        </span>
      </div>
    </button>
  );
}
