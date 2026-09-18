import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  LayoutDashboard, Network, PenLine, RotateCcw, CircleAlert, FlaskConical,
  Zap, Layers, MessagesSquare, Users, ChartNoAxesColumn, Trophy, Settings,
  Menu, X, Volume2, VolumeX, Flame, ChevronsUpDown, LogOut, ShieldCheck, SquarePen,
} from 'lucide-react';
import { CyberGrid } from '@/components/fx/CyberGrid';
import { Starfield } from '@/components/fx/Starfield';
import { Meter } from '@/components/fx/Motion';
import { Toaster } from '@/components/ui/Toaster';
import { useApp } from '@/stores/app';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/theme';
import { cn, cssVar } from '@/lib/utils';
import { levelTitle } from '@/lib/achievements';
import { setSfxEnabled } from '@/lib/sfx';

/* 侧栏导航。
 *
 * 「管理」组是**条件渲染**的 —— 只有管理员看得到。
 * ⚠️ 这只是"不显示入口"，不是鉴权。真正的门在服务端
 * （server/src/routes/admin.js 每个路由都挂 requireAdmin）。
 * 把前端藏起来当成安全措施是最经典的自欺欺人：
 * 用户手敲 /admin 就进来了，页面里再发请求，服务端必须自己挡。 */
function navGroups(isAdmin: boolean) {
  const groups: { group: string; items: { to: string; icon: any; label: string; badge?: 'due' | 'wrong' }[] }[] = [
    {
      group: '学习',
      items: [
        { to: '/', icon: LayoutDashboard, label: '仪表盘' },
        { to: '/learn', icon: Network, label: '知识树' },
        { to: '/quiz', icon: PenLine, label: '每日一练' },
        { to: '/review', icon: RotateCcw, label: '复习队列', badge: 'due' },
        { to: '/mistakes', icon: CircleAlert, label: '错题本', badge: 'wrong' },
        { to: '/questions', icon: SquarePen, label: '我的题库' },
      ],
    },
    {
      group: '训练',
      items: [
        { to: '/lab', icon: FlaskConical, label: '公式实验室' },
        { to: '/blitz', icon: Zap, label: '闪电战' },
        { to: '/deck', icon: Layers, label: '卡片库' },
      ],
    },
    {
      group: 'AI',
      items: [
        { to: '/chat', icon: MessagesSquare, label: 'AI 对话' },
        { to: '/classroom', icon: Users, label: '课堂' },
      ],
    },
    {
      group: '我的',
      items: [
        { to: '/stats', icon: ChartNoAxesColumn, label: '统计' },
        { to: '/achievements', icon: Trophy, label: '成就' },
        { to: '/settings', icon: Settings, label: '设置' },
      ],
    },
  ];

  if (isAdmin) {
    groups.push({
      group: '管理',
      items: [{ to: '/admin', icon: ShieldCheck, label: '用户管理' }],
    });
  }
  return groups;
}

export function AppShell() {
  const { snapshot, refreshSnapshot, sfx, toggleSfx, navOpen, setNavOpen } = useApp();
  const location = useLocation();
  const { user } = useAuth();
  const { theme } = useTheme();

  const NAV = useMemo(() => navGroups(user?.role === 'admin'), [user?.role]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname, setNavOpen]);

  useEffect(() => {
    setSfxEnabled(sfx);
  }, [sfx]);

  // 路由变化时滚回顶部 —— 从长列表进详情页却停在半空很奇怪
  useEffect(() => {
    document.getElementById('main-scroll')?.scrollTo({ top: 0 });
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setNavOpen]);

  const dueCount = snapshot?.dueCount ?? 0;
  const wrongCount = snapshot?.wrong ?? 0;

  return (
    <div className="relative flex min-h-dvh">
      {/* 三层背景，从后往前：
       *   CyberGrid(-z-20) 赛博网格地平线 —— 唯一有"地面"的层，负责纵深
       *   CSS 光晕/静态网格   由 body::before / ::after 画，负责色彩与降级
       *   Starfield(-z-10)   星尘 —— 浮在最前，天空里要有星星
       * 顺序不能换：星星在网格后面就变成"地上的星星"了。
       *
       * ★ 这两层只在**暗色主题**挂载（theme.fx）。原因不是性能，是审美：
       *   霓虹赛博网格 + 磷光星尘画在宣纸那种暖白底上，会变成一片灰蒙蒙的
       *   脏点，既不像纸也不像夜。亮色主题改用 CSS 层的淡色光晕 + 细网格 ——
       *   那本来就是为了"WebGL 挂掉时顶上来"而写的降级路径，正好合适。
       *   不挂载还顺带解决了另一个问题：Starfield 是 Canvas2D，粒子按屏幕面积
       *   算，白底上它那些半透明白点根本看不见，却还在每帧重绘。 */}
      {theme.fx && <CyberGrid />}
      {theme.fx && <Starfield />}

      {/* 移动端遮罩 */}
      <AnimatePresence>
        {navOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-scrim/70 backdrop-blur-sm lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* 侧栏 */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col border-r border-hairline bg-ink-950/72 backdrop-blur-2xl transition-transform duration-300 lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{ transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)' }}
      >
        <Brand />

        <nav className="flex-1 overflow-y-auto px-2.5 pb-3" aria-label="主导航">
          {NAV.map((g) => (
            <div key={g.group} className="mb-3">
              <div className="px-2.5 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-faint">
                {g.group}
              </div>
              {g.items.map((it) => (
                <NavItem
                  key={it.to}
                  {...it}
                  badgeCount={it.badge === 'due' ? dueCount : it.badge === 'wrong' ? wrongCount : 0}
                />
              ))}
            </div>
          ))}
        </nav>

        <SideFooter
          level={snapshot?.level ?? 1}
          xp={snapshot?.levelInfo?.into ?? 0}
          need={snapshot?.levelInfo?.need ?? 100}
          streak={snapshot?.streak ?? 0}
          sfx={sfx}
          onToggleSfx={toggleSfx}
        />
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setNavOpen(true)} />
        <main id="main-scroll" className="min-w-0 flex-1 px-4 pb-16 pt-4 sm:px-6 lg:px-8 lg:pt-6">
          <div className="mx-auto w-full max-w-[1180px]">
            <Outlet />
          </div>
        </main>
      </div>

      <Toaster />
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-4 pb-3 pt-5">
      <div className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-cyan/28 to-violet/22 text-[17px] font-semibold text-cyan-100 ring-1 ring-veil/12">
        <span className="text-aurora">∫</span>
        <span className="absolute inset-0 rounded-xl bg-cyan/18 blur-md -z-10" />
      </div>
      <div className="min-w-0">
        <div className="text-[14.5px] font-semibold leading-none tracking-tight text-fg">研数</div>
        <div className="mt-1 text-[10.5px] leading-none text-fg-faint">考研数学 · 自学</div>
      </div>
    </div>
  );
}

function NavItem({
  to, icon: Icon, label, badgeCount = 0,
}: {
  to: string; icon: any; label: string; badgeCount?: number;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => cn(
        'group relative flex items-center gap-2.5 rounded-xl px-2.5 py-[9px] text-[13px] transition-all duration-200',
        isActive ? 'text-fg' : 'text-fg-mute hover:bg-veil/5 hover:text-fg-soft',
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="nav-active"
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-0 rounded-xl border border-cyan/22 bg-gradient-to-r from-cyan/14 to-violet/10"
            />
          )}
          <Icon
            size={16}
            className={cn('relative shrink-0 transition-colors', isActive ? 'text-cyan' : 'text-fg-mute group-hover:text-fg-soft')}
          />
          <span className="relative flex-1 font-medium">{label}</span>
          {badgeCount > 0 && (
            <span className="relative grid h-[19px] min-w-[19px] place-items-center rounded-full bg-gradient-to-r from-cyan to-blue px-1.5 text-[10.5px] font-bold text-on-accent">
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function SideFooter({
  level, xp, need, streak, sfx, onToggleSfx,
}: {
  level: number; xp: number; need: number; streak: number; sfx: boolean; onToggleSfx: () => void;
}) {
  const pct = need > 0 ? Math.min(100, (xp / need) * 100) : 0;
  return (
    <div className="border-t border-hairline px-3 pb-3 pt-3">
      <div className="glass-subtle rounded-xl p-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-violet/30 to-cyan/22 text-[12px] font-bold text-fg ring-1 ring-veil/10">
              {level}
            </div>
            <div className="leading-none">
              <div className="text-[11.5px] font-medium text-fg-soft">{levelTitle(level)}</div>
              <div className="mt-0.5 text-[10px] text-fg-faint tabular">{xp} / {need} XP</div>
            </div>
          </div>
          <div className="flex items-center gap-1 text-amber">
            <Flame size={13} />
            <span className="text-[13px] font-semibold tabular text-amber-200">{streak}</span>
          </div>
        </div>
        <Meter value={pct} height={4} className="mt-2.5"
          from={cssVar('--color-violet', '#a855f7')} to={cssVar('--color-cyan', '#22d3ee')} />
      </div>

      <button
        onClick={onToggleSfx}
        aria-pressed={sfx}
        className="mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-fg-mute transition-colors hover:bg-veil/5 hover:text-fg-soft"
      >
        {sfx ? <Volume2 size={14} /> : <VolumeX size={14} />}
        <span>音效 {sfx ? '开' : '关'}</span>
      </button>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  /* 标题从导航表里反查，保证「侧栏高亮哪一项」和「顶栏写什么」永远一致 ——
   * 两处各写一张路由→标题的映射，迟早会漂移。
   * 这里自己调一次 navGroups 而不是接 props：TopBar 不是 AppShell 的直接子元素
   * （它和 <Outlet/> 平级），传下去要绕一层，不如就地算。 */
  const title = (() => {
    for (const g of navGroups(user?.role === 'admin')) {
      for (const it of g.items) {
        if (it.to === '/' ? location.pathname === '/' : location.pathname.startsWith(it.to)) return it.label;
      }
    }
    return '研数';
  })();

  const hue = user?.avatarHue ?? 200;

  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-ink-950/58 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          onClick={onMenu}
          aria-label="打开导航菜单"
          className="grid h-9 w-9 place-items-center rounded-lg text-fg-soft transition-colors hover:bg-veil/6 lg:hidden"
        >
          <Menu size={18} />
        </button>

        <h1 className="flex-1 truncate text-[15px] font-semibold tracking-tight text-fg">{title}</h1>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-xl border border-hairline bg-veil/4 py-1.5 pl-1.5 pr-2.5 transition-colors hover:bg-veil/8"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <span
              className="grid h-6 w-6 place-items-center rounded-lg text-[11px] font-bold text-white/95"
              style={{ background: `linear-gradient(135deg, hsl(${hue} 78% 58%), hsl(${(hue + 60) % 360} 78% 52%))` }}
            >
              {(user?.username || '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden text-[12.5px] font-medium text-fg-soft sm:block">{user?.username}</span>
            <ChevronsUpDown size={13} className="text-fg-faint" />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  role="menu"
                  className="glass-strong absolute right-0 top-[calc(100%+8px)] z-20 w-56 overflow-hidden rounded-xl p-1.5"
                >
                  <div className="px-2.5 py-2">
                    <div className="truncate text-[13px] font-medium text-fg">{user?.username}</div>
                    <div className="mt-0.5 truncate text-[11.5px] text-fg-mute">{user?.email}</div>
                  </div>
                  <div className="my-1 h-px bg-hairline" />
                  <button
                    onClick={() => { setMenuOpen(false); logout(); }}
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] text-fg-soft transition-colors hover:bg-rose/12 hover:text-rose-200"
                  >
                    <LogOut size={14} />
                    退出登录
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
