import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bell, BookOpen, CheckCircle2, Cpu, Gauge, Image as ImageIcon,
  Megaphone, RefreshCw, Save, ShieldCheck, Sparkles, ToggleLeft, Users, Zap,
} from 'lucide-react';
import {
  api,
  type AppConfig, type AppCheck, type AppEnv, type AppUsageUser,
} from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { useAuth } from '@/stores/auth';
import { Panel, Button, Input, SectionTitle, Badge, Segmented, Skeleton, Divider, EmptyState } from '@/components/ui/Primitives';
import { cn } from '@/lib/utils';

/* 小程序控制台
 *
 * ── 这个页面是干什么的 ──────────────────────────────────────────
 * 小程序审核一次 1~7 天，发版更久。所以凡是「可能要临时改一下」的
 * 东西都不能写在小程序代码里 —— 功能开关、每日 AI 配额、公告、
 * 维护模式、订阅消息模板、题库版本，全部在这里改，小程序冷启动
 * 拉一次就生效，不用等审核。
 *
 * ── 三条设计决定 ────────────────────────────────────────────────
 * 1. **本地草稿 + 显式保存**。每个开关点了立刻发请求看起来很爽，
 *    但一次保存五个改动比五次往返更好：中途失败时用户面对的是
 *    「哪几个生效了」这种说不清的状态。草稿模式让保存成为一个原子动作。
 *
 * 2. **环境状态和配置并排显示**。填得再漂亮的配置，SERVER_LLM_KEY
 *    没设也是全挂。把「配置值」和「它现在到底能不能跑」放在同一屏，
 *    是为了消灭「配置明明对，为什么还是不行」这类问题。
 *
 * 3. **危险的开关要说清后果**。把 AI 模式从「服务端 Key」切到
 *    「用户自填」，意味着所有用户的 AI 立刻不可用（他们没填过 Key）。
 *    这种事不能只靠一个 toggle 表达。
 */

/* 功能开关的展示信息。键名和 app_config.features 一一对应。
 * 用一张表而不是散在 JSX 里，是因为服务端可能会加新开关 ——
 * 加了之后这里查不到就退化成「用键名当标题」，不会崩。 */
const FEATURE_META: Record<string, { label: string; desc: string }> = {
  review: { label: '复习队列', desc: 'FSRS 到期卡片，小程序的第一入口' },
  quiz: { label: '练习答题', desc: '按考点 / 题型筛题做' },
  mistakes: { label: '错题本', desc: '错题列表与知识图谱根因回溯' },
  aiExplain: { label: 'AI 讲解', desc: '针对你这一步讲透一道题' },
  aiGrade: { label: 'AI 批改', desc: '解答 / 证明题按评分点给分' },
  aiClassroom: { label: '多智能体课堂', desc: '老师 + 三个各错各的同学' },
  lab: { label: '公式实验室', desc: '257 条公式的参数化演示' },
  graph: { label: '知识图谱', desc: '102 条前置依赖边' },
  achievements: { label: '成就与等级', desc: 'XP、12 级、25 项成就' },
};

type Tab = 'overview' | 'features' | 'ai' | 'push' | 'content';

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: '概览' },
  { value: 'features', label: '功能开关' },
  { value: 'ai', label: 'AI 与配额' },
  { value: 'push', label: '订阅消息' },
  { value: 'content', label: '公告与题库' },
];

export default function AppConsole() {
  const navigate = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const me = useAuth((s) => s.user);

  const [tab, setTab] = useState<Tab>('overview');
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const cfg = useAsync(() => api.admin.app.config(), [], { key: 'admin.app.config', staleTime: 10_000 });
  const env = useAsync(() => api.admin.app.env(), [], { key: 'admin.app.env', staleTime: 10_000 });
  const usage = useAsync(() => api.admin.app.usage(14), [], { key: 'admin.app.usage', staleTime: 20_000 });
  const push = useAsync(() => api.admin.app.push(), [], { key: 'admin.app.push', staleTime: 20_000 });
  const render = useAsync(() => api.admin.app.render(), [], { key: 'admin.app.render', staleTime: 20_000 });

  useEffect(() => {
    if (me && me.role !== 'admin') {
      pushToast({ kind: 'warn', title: '需要管理员权限' });
      navigate('/', { replace: true });
    }
  }, [me, navigate, pushToast]);

  /* 服务端配置到了就铺一份草稿。之后所有编辑都改草稿，
   * 点保存才发请求 —— 见文件开头第 1 条设计决定。 */
  useEffect(() => {
    if (cfg.data?.config && !draft) setDraft(structuredClone(cfg.data.config));
  }, [cfg.data, draft]);

  const dirty = useMemo(() => {
    if (!draft || !cfg.data?.config) return false;
    return JSON.stringify(draft) !== JSON.stringify(cfg.data.config);
  }, [draft, cfg.data]);

  /* 改了内容没保存就关页面 —— 浏览器只会弹一个通用提示，
   * 但至少给了个拦截。 */
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api.admin.app.saveConfig(draft as unknown as Record<string, unknown>);
      setDraft(structuredClone(r.config));
      pushToast({
        kind: 'success',
        title: '已保存',
        desc: r.changed.length ? `改动：${r.changed.join('、')}` : '内容没有变化',
      });
      cfg.reload();
      env.reload();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '保存失败', desc: e?.message || '未知错误' });
    } finally {
      setSaving(false);
    }
  }, [draft, pushToast, cfg, env]);

  /** 只改某个区块里的几个字段（深合并语义由服务端保证）。 */
  const patch = useCallback(<K extends keyof AppConfig>(k: K, v: Partial<AppConfig[K]>) => {
    setDraft((d) => (d ? { ...d, [k]: { ...(d[k] as object), ...v } } : d));
  }, []);

  const setFeature = useCallback((key: string, v: boolean) => {
    setDraft((d) => (d ? { ...d, features: { ...d.features, [key]: v } } : d));
  }, []);

  const setQuota = useCallback(async (u: AppUsageUser, limit: number | null) => {
    try {
      await api.admin.app.setQuota(u.id, limit);
      pushToast({ kind: 'success', title: '配额已更新', desc: `${u.username} → ${limit === null ? '跟随全局' : limit === 0 ? '不限' : `每日 ${limit} 次`}` });
      usage.reload();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '更新失败', desc: e?.message || '' });
    }
  }, [pushToast, usage]);

  if (!me || me.role !== 'admin') return null;

  const loading = !draft && cfg.loading;
  const checks = env.data?.checks || [];
  const errors = checks.filter((c) => c.level === 'error');

  return (
    <div className="space-y-5">
      {/* ---------- 头部 ---------- */}
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
              <ShieldCheck size={19} />
            </div>
            <div>
              <h1 className="text-[15px] font-medium text-fg">小程序控制台</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                这里的改动小程序下次冷启动即生效，不需要重新提审
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { cfg.reload(); env.reload(); usage.reload(); push.reload(); render.reload(); }}>
              <RefreshCw size={14} className="mr-1.5" /> 刷新
            </Button>
            <Button variant={dirty ? 'primary' : 'subtle'} size="sm" onClick={save} disabled={!dirty || saving} loading={saving}>
              <Save size={14} className="mr-1.5" /> {dirty ? '保存改动' : '已保存'}
            </Button>
          </div>
        </div>

        {/* ★ 这里只放一个计数入口，不重复列错误内容。
         *   一开始把完整错误列表放在这里，结果它和下面「环境自检」面板
         *   里的列表一模一样 —— 同一段话在同一屏出现两遍，看起来像
         *   渲染重复了。细节归面板，这里只负责「告诉你有事」并把人送过去。 */}
        {errors.length > 0 && (
          <button
            onClick={() => setTab('overview')}
            className="mt-4 flex w-full items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-400/8 px-3 py-2.5 text-left transition-colors hover:bg-rose-400/12"
          >
            <AlertTriangle size={14} className="shrink-0 text-rose-300" />
            <span className="text-[12.5px] text-rose-100/90">
              有 {errors.length} 项环境问题会让功能直接不可用
            </span>
            <span className="ml-auto text-[11.5px] text-rose-200/70">查看详情 →</span>
          </button>
        )}
      </Panel>

      <Segmented value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.value, label: t.label }))} />

      {loading && <Skeleton className="h-64 w-full" />}

      {draft && (
        <>
          {tab === 'overview' && (
            <OverviewTab
              env={cfg.data?.env}
              checks={checks}
              usage={usage.data}
              render={render.data}
              draft={draft}
              onWarm={async () => {
                try { const r = await api.admin.app.warmRender(); pushToast({ kind: 'success', title: '预热完成', desc: `${r.files} 个文件，${r.mb} MB` }); render.reload(); }
                catch (e: any) { pushToast({ kind: 'error', title: '预热失败', desc: e?.message || '' }); }
              }}
              onClear={async () => {
                try { const r = await api.admin.app.clearRender(); pushToast({ kind: 'success', title: '缓存已清空', desc: `删除 ${r.removed} 个文件` }); render.reload(); }
                catch (e: any) { pushToast({ kind: 'error', title: '清理失败', desc: e?.message || '' }); }
              }}
            />
          )}

          {tab === 'features' && (
            <FeaturesTab draft={draft} setFeature={setFeature} />
          )}

          {tab === 'ai' && (
            <AiTab
              draft={draft}
              patch={patch}
              env={cfg.data?.env}
              usage={usage.data}
              onSetQuota={setQuota}
            />
          )}

          {tab === 'push' && (
            <PushTab draft={draft} patch={patch} push={push.data} />
          )}

          {tab === 'content' && (
            <ContentTab draft={draft} patch={patch} />
          )}
        </>
      )}
    </div>
  );
}

/* ============================================================
   概览
   ============================================================ */

/** SectionTitle 只接受 title/desc/right，不接 icon。
 *  这里包一层把图标塞进 title 里 —— 比在每个调用点手写一遍
 *  <span className="flex ..."> 干净，也比改公共组件的签名安全
 *  （那个组件被十几个页面用着）。 */
function SecTitle({ icon, title, desc }: { icon: React.ReactNode; title: string; desc?: string }) {
  return (
    <SectionTitle
      title={<span className="flex items-center gap-2">{icon}{title}</span>}
      desc={desc}
    />
  );
}

function OverviewTab({
  env, checks, usage, render, draft, onWarm, onClear,
}: {
  env?: AppEnv;
  checks: AppCheck[];
  usage?: { total: number; day: string; users: AppUsageUser[]; trend: { day: string; calls: number }[] } | null;
  render?: { files: number; mb: number; pngAvailable: boolean } | null;
  draft: AppConfig;
  onWarm: () => void;
  onClear: () => void;
}) {
  const activeUsers = usage?.users.filter((u) => u.calls > 0).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat icon={<Zap size={15} />} label="今日 AI 调用" value={usage?.total ?? 0} sub={`${activeUsers} 人用过`} />
        <MiniStat icon={<Users size={15} />} label="AI 配额上限" value={draft.ai.dailyCalls === 0 ? '不限' : draft.ai.dailyCalls} sub={`模式：${draft.ai.mode === 'server' ? '服务端统一 Key' : '用户自填 Key'}`} />
        <MiniStat icon={<ImageIcon size={15} />} label="公式图缓存" value={render?.files ?? 0} sub={`${render?.mb ?? 0} MB`} />
        <MiniStat icon={<Bell size={15} />} label="推送时间" value={`${String(draft.push.hour).padStart(2, '0')}:00`} sub={draft.push.on ? '已开启' : '未开启'} />
      </div>

      <Panel className="p-5">
        <SecTitle icon={<Cpu size={15} />} title="环境自检" desc="配置项填对了不代表能跑起来，这里检查的是「依赖到底在不在」" />
        <div className="mt-4 space-y-2">
          {checks.length === 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-3 py-2.5">
              <CheckCircle2 size={14} className="text-emerald-300" />
              <p className="text-[12.5px] text-emerald-100/90">全部通过，没有发现问题。</p>
            </div>
          )}
          {checks.map((c) => (
            <div
              key={c.key}
              className={cn(
                'flex items-start gap-2 rounded-xl border px-3 py-2.5',
                c.level === 'error'
                  ? 'border-rose-400/25 bg-rose-400/8'
                  : 'border-amber-400/25 bg-amber-400/8',
              )}
            >
              <AlertTriangle size={14} className={cn('mt-0.5 shrink-0', c.level === 'error' ? 'text-rose-300' : 'text-amber-300')} />
              <p className="text-[12.5px] leading-relaxed text-fg-soft">{c.message}</p>
            </div>
          ))}
        </div>

        <Divider className="my-4" />

        <div className="grid gap-2 text-[12.5px] sm:grid-cols-2">
          <EnvRow label="SERVER_LLM_KEY" ok={env?.serverLlmKey} okText="已配置" badText="未配置" />
          <EnvRow label="WX_APPID / WX_SECRET" ok={env?.wxAppId && env?.wxSecret} okText="已配置" badText="未配置" />
          <EnvRow label="PNG 光栅化（resvg）" ok={env?.pngAvailable} okText="可用" badText="不可用，公式会降级成 SVG" />
          <EnvRow label="NODE_ENV" ok={env?.nodeEnv === 'production'} okText="production" badText={`${env?.nodeEnv || '未知'}（cookie 没有 Secure 标记）`} />
        </div>

        <Divider className="my-4" />

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onWarm}>
            <Sparkles size={14} className="mr-1.5" /> 预热公式图
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear}>
            清空渲染缓存
          </Button>
          <span className="text-[12px] text-fg-mute">
            预热会把题库里所有公式先渲一遍，之后第一个打开题目的人不用等。
          </span>
        </div>
      </Panel>
    </div>
  );
}

function MiniStat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Panel className="p-4">
      <div className="flex items-center gap-2 text-fg-mute">
        {icon}
        <span className="text-[12px]">{label}</span>
      </div>
      <div className="mt-2 text-[22px] font-medium leading-none text-fg">{value}</div>
      {sub && <div className="mt-1.5 text-[11.5px] text-fg-mute">{sub}</div>}
    </Panel>
  );
}

function EnvRow({ label, ok, okText, badText }: { label: string; ok?: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-2">
      <span className="font-mono text-[11.5px] text-fg-mute">{label}</span>
      <Badge tone={ok ? 'emerald' : 'amber'}>{ok ? okText : badText}</Badge>
    </div>
  );
}

/* ============================================================
   功能开关
   ============================================================ */
function FeaturesTab({ draft, setFeature }: { draft: AppConfig; setFeature: (k: string, v: boolean) => void }) {
  return (
    <Panel className="p-5">
      <SecTitle
        icon={<ToggleLeft size={15} />}
        title="功能开关"
        desc="只控制小程序里的入口显不显示。真正的权限在服务端路由，藏起来不等于拦住了。"
      />
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {Object.keys(draft.features).map((key) => {
          const meta = FEATURE_META[key] || { label: key, desc: '' };
          const on = draft.features[key];
          return (
            <button
              key={key}
              onClick={() => setFeature(key, !on)}
              className={cn(
                'flex items-start justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                on ? 'border-emerald-400/30 bg-emerald-400/8' : 'border-hairline bg-veil/4 hover:bg-veil/6',
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-fg">{meta.label}</span>
                  <span className="font-mono text-[10.5px] text-fg-mute">{key}</span>
                </div>
                {meta.desc && <p className="mt-1 text-[11.5px] leading-relaxed text-fg-mute">{meta.desc}</p>}
              </div>
              <span
                className={cn(
                  'mt-0.5 grid h-5 w-9 shrink-0 place-items-center rounded-full transition-colors',
                  on ? 'bg-emerald-400/80' : 'bg-veil/15',
                )}
              >
                <span className={cn('h-3.5 w-3.5 rounded-full bg-white transition-transform', on ? 'translate-x-2' : '-translate-x-2')} />
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/* ============================================================
   AI 与配额
   ============================================================ */
function AiTab({
  draft, patch, env, usage, onSetQuota,
}: {
  draft: AppConfig;
  patch: <K extends keyof AppConfig>(k: K, v: Partial<AppConfig[K]>) => void;
  env?: AppEnv;
  usage?: { total: number; day: string; globalLimit: number; users: AppUsageUser[] } | null;
  onSetQuota: (u: AppUsageUser, limit: number | null) => void;
}) {
  const serverMode = draft.ai.mode === 'server';

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <SecTitle icon={<Cpu size={15} />} title="模型接入" desc="决定所有用户走谁的 Key" />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[12.5px] font-medium text-fg-soft">Key 归属</div>
            <div className="flex flex-wrap gap-2">
              {([
                { v: 'server', label: '服务端统一 Key', desc: '用户开箱即用，费用由你承担' },
                { v: 'byok', label: '用户自填 Key', desc: '不花钱，但每个用户要自己去设置页填' },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  onClick={() => patch('ai', { mode: o.v })}
                  className={cn(
                    'flex-1 rounded-xl border px-3.5 py-3 text-left transition-colors',
                    draft.ai.mode === o.v ? 'border-cyan-400/35 bg-cyan-400/10' : 'border-hairline bg-veil/4 hover:bg-veil/6',
                  )}
                >
                  <div className="text-[13px] font-medium text-fg">{o.label}</div>
                  <div className="mt-1 text-[11.5px] text-fg-mute">{o.desc}</div>
                </button>
              ))}
            </div>
            {!serverMode && (
              <p className="mt-2 text-[11.5px] leading-relaxed text-amber-200/80">
                切到「用户自填」后，所有没填过 Key 的用户 AI 功能会立刻不可用 —— 他们得自己去设置页补。
              </p>
            )}
            {serverMode && !env?.serverLlmKey && (
              <p className="mt-2 text-[11.5px] leading-relaxed text-rose-200/85">
                当前是服务端统一 Key 模式，但 SERVER_LLM_KEY 没设 —— AI 接口会全部返回 400。
              </p>
            )}
          </div>

          <Input
            label="上游地址"
            value={draft.ai.base}
            onChange={(e) => patch('ai', { base: e.target.value })}
            placeholder="https://api.deepseek.com"
            hint="必须是 http(s):// 开头。这个地址由管理员统一指定，用户改不了。"
          />
          <Input
            label="模型名"
            value={draft.ai.model}
            onChange={(e) => patch('ai', { model: e.target.value })}
            placeholder="deepseek-chat"
          />
          <Input
            label="Vision 模型名（可选）"
            value={draft.ai.visionModel}
            onChange={(e) => patch('ai', { visionModel: e.target.value })}
            placeholder="留空则复用上面的模型名"
            hint="多模态图片识别专用。deepseek-chat、gpt-4o、claude-3 都支持 vision。"
          />
          <Input
            label="每用户每日调用上限"
            type="number"
            min={0}
            value={String(draft.ai.dailyCalls)}
            onChange={(e) => patch('ai', { dailyCalls: Number(e.target.value) })}
            hint="0 表示不限。建议给个具体值 —— 不设上限的账号是最容易被忽略的成本来源。"
          />
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SecTitle icon={<Gauge size={15} />} title="今日用量" desc={`${usage?.day || '—'} · 合计 ${usage?.total ?? 0} 次`} />
          <span className="text-[11.5px] text-fg-mute">个人覆盖为空时跟随全局（{draft.ai.dailyCalls === 0 ? '不限' : draft.ai.dailyCalls} 次）</span>
        </div>

        <div className="mt-4 space-y-1.5">
          {!usage?.users.length && <EmptyState title="还没有用户" desc="小程序那边有人登录之后，这里就会出现。" />}
          {usage?.users.map((u) => {
            const pct = u.limit === 0 ? 0 : Math.min(100, Math.round((u.calls / Math.max(1, u.limit)) * 100));
            return (
              <div key={u.id} className="rounded-xl border border-hairline px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[12.5px] text-fg">{u.username}</span>
                    <span className="ml-2 font-mono text-[11px] text-fg-mute">{u.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11.5px] text-fg-soft">
                      {u.calls} / {u.limit === 0 ? '不限' : u.limit}
                    </span>
                    {u.override !== null && <Badge tone="violet">个人覆盖</Badge>}
                    <select
                      value={u.override === null ? 'inherit' : String(u.override)}
                      onChange={(e) => {
                        const v = e.target.value;
                        onSetQuota(u, v === 'inherit' ? null : Number(v));
                      }}
                      className="rounded-lg border border-hairline bg-veil/6 px-2 py-1 text-[11.5px] text-fg-soft outline-none"
                    >
                      <option value="inherit">跟随全局</option>
                      <option value="0">不限</option>
                      <option value="10">10 次/日</option>
                      <option value="30">30 次/日</option>
                      <option value="50">50 次/日</option>
                      <option value="100">100 次/日</option>
                    </select>
                  </div>
                </div>
                {u.limit !== 0 && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-veil/10">
                    <div
                      className={cn('h-full rounded-full transition-all', pct >= 90 ? 'bg-rose-400/80' : 'bg-cyan-400/70')}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   订阅消息
   ============================================================ */
function PushTab({
  draft, patch, push,
}: {
  draft: AppConfig;
  patch: <K extends keyof AppConfig>(k: K, v: Partial<AppConfig[K]>) => void;
  push?: { stats: { total: number; ok: number; failed: number }; subscribers: number; withQuota: number; subs: { email: string; quota_left: number; granted: number }[]; logs: { id: number; email: string | null; ok: number; errcode: number | null; errmsg: string | null; at: string }[] } | null;
}) {
  /* payload 用 JSON 文本框编辑。
   *
   * 为什么不做成「字段名 + 内容」两个输入框的列表：模板字段数量不定
   * （有的模板 2 个、有的 5 个），做固定数量的输入框就得猜。JSON 虽然
   * 对非技术用户不友好，但它是唯一能表达任意字段集合的形式，
   * 而且填错时能立刻报「第几个字符解析失败」。 */
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(draft.push.payload || {}, null, 2));
  const [payloadErr, setPayloadErr] = useState('');
  const [running, setRunning] = useState<'' | 'dry' | 'real'>('');
  const [runResult, setRunResult] = useState<string>('');

  /* 外部配置被重置（比如点了「刷新」）时同步回来。
   * 用 draft 里那份的序列化结果做依赖，而不是对象本身 ——
   * 对象每次渲染都是新引用，会无限同步。 */
  const serialized = JSON.stringify(draft.push.payload || {});
  useEffect(() => {
    setPayloadText(JSON.stringify(draft.push.payload || {}, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  const onPayloadChange = (v: string) => {
    setPayloadText(v);
    try {
      const parsed = JSON.parse(v);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setPayloadErr('必须是一个对象，形如 {"thing1": "今天有 {due} 张卡片到期"}');
        return;
      }
      for (const [k, val] of Object.entries(parsed)) {
        if (typeof val !== 'string') {
          setPayloadErr(`字段 ${k} 的值必须是字符串`);
          return;
        }
      }
      setPayloadErr('');
      patch('push', { payload: parsed as Record<string, string> });
    } catch (e: any) {
      setPayloadErr('JSON 解析失败：' + (e?.message || ''));
    }
  };

  const run = async (dryRun: boolean) => {
    setRunning(dryRun ? 'dry' : 'real');
    setRunResult('');
    try {
      const r = await api.admin.app.runPush(dryRun);
      if (r.error) setRunResult('失败：' + r.error);
      else if (r.skipped) setRunResult('跳过：' + (r.reason || ''));
      else if (dryRun) setRunResult(`试跑：会推给 ${r.candidates ?? 0} 个人（没有真的发）`);
      else setRunResult(`已推送：成功 ${r.sent ?? 0} · 失败 ${r.failed ?? 0}`);
    } catch (e: any) {
      setRunResult('请求失败：' + (e?.message || ''));
    } finally {
      setRunning('');
    }
  };

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <SecTitle icon={<Bell size={15} />} title="每日复习提醒" desc="FSRS 的本质是「到期必须被提醒」，这是小程序相对网页最大的优势" />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 flex items-center justify-between rounded-xl border border-hairline px-3.5 py-3">
            <div>
              <div className="text-[13px] font-medium text-fg">开启推送</div>
              <div className="mt-0.5 text-[11.5px] text-fg-mute">到点给「今天有到期卡且有推送额度」的用户各发一条</div>
            </div>
            <button
              onClick={() => patch('push', { on: !draft.push.on })}
              className={cn('grid h-5 w-9 place-items-center rounded-full transition-colors', draft.push.on ? 'bg-emerald-400/80' : 'bg-veil/15')}
            >
              <span className={cn('h-3.5 w-3.5 rounded-full bg-white transition-transform', draft.push.on ? 'translate-x-2' : '-translate-x-2')} />
            </button>
          </div>

          <Input
            label="订阅消息模板 ID"
            value={draft.push.templateId}
            onChange={(e) => patch('push', { templateId: e.target.value })}
            placeholder="在微信公众平台「订阅消息」里申请后复制"
            hint="微信的订阅消息是一次性的：用户允许一次，只能发一条。所以这里记的是额度，不是永久许可。"
          />
          <Input
            label="推送时间（小时）"
            type="number"
            min={0}
            max={23}
            value={String(draft.push.hour)}
            onChange={(e) => patch('push', { hour: Number(e.target.value) })}
            hint="0~23。建议 20 点 —— 晚饭后、自习前。"
          />
          <Input
            label="点击后跳转页面"
            value={draft.push.page}
            onChange={(e) => patch('push', { page: e.target.value })}
            placeholder="pages/review/index"
            hint="必须是小程序里真实存在的页面路径，否则点击会白屏。"
          />

          {/* 模板字段映射 */}
          <div className="sm:col-span-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-fg-soft">模板字段映射</span>
              <span className="text-[11px] text-fg-mute">
                占位符：{'{due}'} {'{streak}'} {'{date}'} {'{time}'} {'{name}'}
              </span>
            </div>
            <textarea
              value={payloadText}
              onChange={(e) => onPayloadChange(e.target.value)}
              rows={5}
              spellCheck={false}
              className={cn(
                'w-full resize-y rounded-xl border bg-veil/4 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg outline-none',
                payloadErr ? 'border-rose-400/50' : 'border-hairline focus:border-cyan-400/40',
              )}
            />
            {payloadErr ? (
              <p className="mt-1.5 text-[11.5px] text-rose-300">{payloadErr}</p>
            ) : (
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-mute">
                键是你在公众平台选的模板里的字段名（thing1 / time2…），值是内容。
                填错的话微信会返回 47003「参数不匹配」，那句话看不出是字段名的问题 —— 所以先试跑。
              </p>
            )}
          </div>

          {/* 手动触发 */}
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
            <Button variant="outline" size="sm" onClick={() => run(true)} disabled={running !== ''} loading={running === 'dry'}>
              试跑（不发）
            </Button>
            <Button variant="ghost" size="sm" onClick={() => run(false)} disabled={running !== ''} loading={running === 'real'}>
              立即推送一次
            </Button>
            <span className="text-[11.5px] text-fg-mute">
              定时任务每天 {String(draft.push.hour).padStart(2, '0')}:00 自动跑
            </span>
          </div>

          {runResult && (
            <div className="sm:col-span-2 rounded-xl border border-cyan-400/20 bg-cyan-400/8 px-3 py-2 text-[12px] text-cyan-100/90">
              {runResult}
            </div>
          )}
        </div>
      </Panel>

      <Panel className="p-5">
        <SecTitle icon={<Bell size={15} />} title="授权与投递" desc="「昨天推了没有、失败在哪」—— 没有这张表，推送就是个黑盒" />
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <MiniStat icon={<Users size={15} />} label="授权用户" value={push?.subscribers ?? 0} sub={`其中 ${push?.withQuota ?? 0} 人还有额度`} />
          <MiniStat icon={<CheckCircle2 size={15} />} label="近 7 天成功" value={push?.stats.ok ?? 0} sub={`失败 ${push?.stats.failed ?? 0}`} />
          <MiniStat icon={<Bell size={15} />} label="近 7 天总投递" value={push?.stats.total ?? 0} />
        </div>

        <Divider className="my-4" />

        <div className="space-y-1.5">
          {!push?.logs.length && <p className="text-[12.5px] text-fg-mute">还没有投递记录。</p>}
          {push?.logs.slice(0, 12).map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-2">
              <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-mute">{l.email || '—'}</span>
              <div className="flex shrink-0 items-center gap-2">
                {l.ok ? <Badge tone="emerald">成功</Badge> : <Badge tone="rose">{l.errcode ?? '失败'}</Badge>}
                <span className="text-[11px] text-fg-mute">{l.at}</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   公告与题库
   ============================================================ */
function ContentTab({ draft, patch }: { draft: AppConfig; patch: <K extends keyof AppConfig>(k: K, v: Partial<AppConfig[K]>) => void }) {
  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <SecTitle icon={<Megaphone size={15} />} title="公告" desc="改完保存，用户下次打开小程序就能看到" />

        <div className="mt-4 grid gap-4">
          <div className="flex items-center justify-between rounded-xl border border-hairline px-3.5 py-3">
            <div>
              <div className="text-[13px] font-medium text-fg">显示公告</div>
              <div className="mt-0.5 text-[11.5px] text-fg-mute">小程序首页顶部会挂一条横幅</div>
            </div>
            <button
              onClick={() => patch('notice', { on: !draft.notice.on })}
              className={cn('grid h-5 w-9 place-items-center rounded-full transition-colors', draft.notice.on ? 'bg-emerald-400/80' : 'bg-veil/15')}
            >
              <span className={cn('h-3.5 w-3.5 rounded-full bg-white transition-transform', draft.notice.on ? 'translate-x-2' : '-translate-x-2')} />
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="标题" value={draft.notice.title} onChange={(e) => patch('notice', { title: e.target.value })} placeholder="冲刺阶段，每天 20 张卡" />
            <div>
              <div className="mb-1.5 text-[12.5px] font-medium text-fg-soft">级别</div>
              <Segmented
                value={draft.notice.level}
                onChange={(v) => patch('notice', { level: v })}
                options={[{ value: 'info', label: '普通' }, { value: 'warn', label: '重要' }]}
                size="sm"
              />
            </div>
            <div className="sm:col-span-2">
              <div className="mb-1.5 text-[12.5px] font-medium text-fg-soft">正文</div>
              <textarea
                value={draft.notice.body}
                onChange={(e) => patch('notice', { body: e.target.value })}
                rows={3}
                className="w-full resize-y rounded-xl border border-hairline bg-veil/4 px-3 py-2.5 text-[13px] text-fg outline-none focus:border-cyan-400/40"
                placeholder="写一句话，别太长 —— 手机上一屏放不下就没人看了"
              />
            </div>
          </div>
        </div>
      </Panel>

      <Panel className="p-5">
        <SecTitle icon={<AlertTriangle size={15} />} title="维护模式" desc="开启后小程序会显示维护提示，所有业务接口仍可用" />
        <div className="mt-4 grid gap-4">
          <div className="flex items-center justify-between rounded-xl border border-hairline px-3.5 py-3">
            <div>
              <div className="text-[13px] font-medium text-fg">进入维护模式</div>
              <div className="mt-0.5 text-[11.5px] text-fg-mute">用于迁库、改结构这类会短暂不可用的操作</div>
            </div>
            <button
              onClick={() => patch('maintenance', { on: !draft.maintenance.on })}
              className={cn('grid h-5 w-9 place-items-center rounded-full transition-colors', draft.maintenance.on ? 'bg-rose-400/80' : 'bg-veil/15')}
            >
              <span className={cn('h-3.5 w-3.5 rounded-full bg-white transition-transform', draft.maintenance.on ? 'translate-x-2' : '-translate-x-2')} />
            </button>
          </div>
          <Input label="提示文案" value={draft.maintenance.message} onChange={(e) => patch('maintenance', { message: e.target.value })} />
        </div>
      </Panel>

      <Panel className="p-5">
        <SecTitle icon={<BookOpen size={15} />} title="版本与题库" desc="题库内容改了就把版本号 +1，小程序会重新拉清单" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Input label="小程序最新版本" value={draft.version.latest} onChange={(e) => patch('version', { latest: e.target.value })} placeholder="1.0.0" />
          <Input
            label="最低可用版本"
            value={draft.version.min}
            onChange={(e) => patch('version', { min: e.target.value })}
            placeholder="留空表示不强制更新"
            hint="低于这个版本的客户端会被要求更新。改接口返回结构后必须填。"
          />
          <Input label="更新说明" value={draft.version.note} onChange={(e) => patch('version', { note: e.target.value })} placeholder="修了几个公式显示问题" />
          <Input
            label="题库版本号"
            type="number"
            min={1}
            value={String(draft.bank.version)}
            onChange={(e) => patch('bank', { version: Number(e.target.value) })}
            hint="改题、加题之后 +1。小程序按它判断本地缓存要不要作废。"
          />
          <Input
            label="题库 / 公式图静态地址"
            value={draft.bank.baseUrl}
            onChange={(e) => patch('bank', { baseUrl: e.target.value })}
            placeholder="留空表示走本站"
            hint="上了 CDN 之后填这里。必须以 http(s):// 开头。"
          />
        </div>
      </Panel>
    </div>
  );
}
