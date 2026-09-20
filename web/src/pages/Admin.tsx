import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, ArrowDownUp, Ban, CheckCircle2, CircleAlert, Clock, Database,
  KeyRound, Loader2, LogOut, Pencil, Plus, RefreshCw, Search, ShieldCheck,
  Trash2, Users,
} from 'lucide-react';
import {
  api,
  type AdminLogEntry, type AdminUser, type AdminUserDetail,
} from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { useAuth } from '@/stores/auth';
import { Panel, Button, Input, SectionTitle, Badge, Segmented, Skeleton, Divider, EmptyState } from '@/components/ui/Primitives';
import { Modal } from '@/components/ui/Modal';
import { cn, relTime } from '@/lib/utils';

/* 管理台
 *
 * ── 三条产品决定 ────────────────────────────────────────────────
 * 1. **能看统计，看不到内容**。管理员看得到「作答 128 次 / 正确率 76%」，
 *    看不到他答了哪道题、笔记写了什么、聊天记录是什么。管理不是监视 ——
 *    这个边界在服务端就切好了（/api/admin/users/:id 不返回那些字段），
 *    前端也没有入口。
 *
 * 2. **危险操作必须"慢一下"**。删号要求手打邮箱、重置密码要把新密码
 *    抄给本人、停用会当场踢掉所有会话 —— 每一条都在弹窗里写清楚后果。
 *    管理后台最贵的成本不是点错按钮，是点错了还不知道自己干了什么。
 *
 * 3. **审计可见**。每次改动都写 admin_log，页面上直接能看到谁在什么时候
 *    改了什么。没有这一层，多人共用一个后台时出了事查不出责任人。
 *
 * ── 关于"删掉自己"这类护栏 ─────────────────────────────────────
 * 服务端已经挡住了（SELF_DELETE / SELF_DEMOTE / LAST_ADMIN），
 * 这里也把按钮置灰并给出原因 —— 让人点了才知道不行，是很差的体验。
 * 但置灰只是体验优化，真正的门永远在服务端。
 */
export default function Admin() {
  const navigate = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const me = useAuth((s) => s.user);

  /* 前端这一层只是"别让人白跑一趟"。非管理员即便手敲 /admin 进来，
   * 下面每个请求也都会被服务端 403 挡掉。 */
  useEffect(() => {
    if (me && me.role !== 'admin') {
      pushToast({ kind: 'warn', title: '需要管理员权限' });
      navigate('/', { replace: true });
    }
  }, [me, navigate, pushToast]);

  const [q, setQ] = useState('');
  const [role, setRole] = useState<'' | 'user' | 'admin'>('');
  const [status, setStatus] = useState<'' | 'active' | 'disabled'>('');
  const [sort, setSort] = useState('created');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [debouncedQ, setDebouncedQ] = useState('');

  /* 搜索防抖：每敲一个字就发一次请求，既浪费又会造成"结果乱跳" */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const overview = useAsync(() => api.admin.overview(), [], { key: 'admin.overview' });
  const list = useAsync(
    () => api.admin.users({ q: debouncedQ, role, status, sort, dir, limit: 100 }),
    [debouncedQ, role, status, sort, dir],
    /* 筛选条件进 key：来回切「只看管理员 / 只看停用」时结果是现成的。
     * 缓存有 200 条上限，打字搜出来的中间态会被自动淘汰掉。 */
    { key: `admin.users:${debouncedQ}|${role}|${status}|${sort}|${dir}`, staleTime: 15_000 },
  );
  const logs = useAsync(() => api.admin.logs(40), [], { key: 'admin.logs:40' });

  const reloadAll = useCallback(() => {
    overview.reload();
    list.reload();
    logs.reload();
  }, [overview, list, logs]);

  /* 弹窗状态。用一个大对象装，比开八个 useState 好读 ——
   * 它们之间是互斥的（同一时刻只会开一个）。 */
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [pwdTarget, setPwdTarget] = useState<AdminUser | null>(null);
  const [delTarget, setDelTarget] = useState<AdminUser | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  if (!me || me.role !== 'admin') return null;

  const rows = list.data?.users || [];
  const busy = list.loading && !list.data;

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan/25 bg-cyan/10 text-cyan">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">用户管理</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                账号、角色、状态，以及每个人的学情概览
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reloadAll} loading={list.loading}>
              <RefreshCw size={13} /> 刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> 新建用户
            </Button>
          </div>
        </div>

        <Divider className="my-4" />

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MiniStat label="总用户" value={overview.data?.totals.users} icon={<Users size={13} />} />
          <MiniStat label="管理员" value={overview.data?.totals.admins} icon={<ShieldCheck size={13} />} tone="cyan" />
          <MiniStat label="已停用" value={overview.data?.totals.disabled} icon={<Ban size={13} />} tone="rose" />
          <MiniStat label="今日活跃" value={overview.data?.totals.activeToday} icon={<Activity size={13} />} tone="emerald" />
          <MiniStat
            label="累计作答"
            value={overview.data?.activity.attempts}
            sub={overview.data ? `正确率 ${overview.data.activity.accuracy}%` : undefined}
            icon={<CircleAlert size={13} />}
            tone="violet"
          />
          <MiniStat
            label="库大小"
            value={overview.data ? `${overview.data.activity.dbMb}` : undefined}
            sub="MB · SQLite"
            icon={<Database size={13} />}
            tone="amber"
          />
        </div>
      </Panel>

      {/* 用户表 */}
      <Panel className="p-5">
        <SectionTitle
          title="账号列表"
          desc="点任意一行看详情；所有写操作都会记进审计日志"
          right={<Badge tone="neutral">{list.data?.total ?? 0} 个</Badge>}
          className="mb-4"
        />

        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[190px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute">
              <Search size={14} />
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜邮箱、昵称或备注"
              aria-label="搜索用户"
              className="h-10 w-full rounded-xl border border-hairline bg-veil/4 pl-9 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-cyan/50"
            />
          </div>
          <Segmented
            size="sm"
            value={role}
            onChange={setRole}
            options={[
              { value: '', label: '全部角色' },
              { value: 'user', label: '普通' },
              { value: 'admin', label: '管理员' },
            ]}
          />
          <Segmented
            size="sm"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: '全部状态' },
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '停用' },
            ]}
          />
        </div>

        {busy ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
          </div>
        ) : list.error ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-rose/28 bg-rose/8 px-3.5 py-3 text-[12.5px] text-rose-100">
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            <span>{list.error}</span>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="没有匹配的账号" desc="换个关键词或清掉筛选条件试试。" />
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-fg-faint">
                  <Th onClick={() => toggleSort('email', sort, dir, setSort, setDir)} active={sort === 'email'}>
                    账号 <ArrowDownUp size={10} className="inline opacity-50" />
                  </Th>
                  <th className="px-2 py-2 font-medium">角色 / 状态</th>
                  <Th onClick={() => toggleSort('attempts', sort, dir, setSort, setDir)} active={sort === 'attempts'}>
                    作答 <ArrowDownUp size={10} className="inline opacity-50" />
                  </Th>
                  <Th onClick={() => toggleSort('accuracy', sort, dir, setSort, setDir)} active={sort === 'accuracy'}>
                    正确率 <ArrowDownUp size={10} className="inline opacity-50" />
                  </Th>
                  <Th onClick={() => toggleSort('xp', sort, dir, setSort, setDir)} active={sort === 'xp'}>
                    XP / 等级 <ArrowDownUp size={10} className="inline opacity-50" />
                  </Th>
                  <th className="px-2 py-2 font-medium">卡片</th>
                  <Th onClick={() => toggleSort('lastLogin', sort, dir, setSort, setDir)} active={sort === 'lastLogin'}>
                    最近登录 <ArrowDownUp size={10} className="inline opacity-50" />
                  </Th>
                  <th className="px-2 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <Row
                    key={u.id}
                    u={u}
                    meId={me.id}
                    onDetail={() => setDetailId(u.id)}
                    onEdit={() => setEditTarget(u)}
                    onPwd={() => setPwdTarget(u)}
                    onDelete={() => setDelTarget(u)}
                    onToggled={reloadAll}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* 审计日志 */}
      <Panel className="p-5">
        <SectionTitle
          title="管理审计"
          desc="谁、什么时候、对谁、做了什么。写操作全部留痕。"
          right={<Badge tone="neutral">{(logs.data?.logs || []).length} 条</Badge>}
          className="mb-4"
        />
        <LogList logs={logs.data?.logs || []} loading={logs.loading && !logs.data} />
      </Panel>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); reloadAll(); }}
      />
      <EditUserModal
        target={editTarget}
        meId={me.id}
        onClose={() => setEditTarget(null)}
        onDone={() => { setEditTarget(null); reloadAll(); }}
      />
      <ResetPasswordModal
        target={pwdTarget}
        onClose={() => setPwdTarget(null)}
        onDone={() => { setPwdTarget(null); reloadAll(); }}
      />
      <DeleteUserModal
        target={delTarget}
        onClose={() => setDelTarget(null)}
        onDone={() => { setDelTarget(null); reloadAll(); }}
      />
      <UserDetailModal
        id={detailId}
        meId={me.id}
        onClose={() => setDetailId(null)}
        onChanged={reloadAll}
      />
    </div>
  );
}

/* ============ 小件 ============ */

function toggleSort(key: string, cur: string, dir: 'asc' | 'desc', setSort: (s: string) => void, setDir: (d: 'asc' | 'desc') => void) {
  if (cur === key) setDir(dir === 'asc' ? 'desc' : 'asc');
  else { setSort(key); setDir('desc'); }
}

function Th({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active: boolean }) {
  return (
    <th className="px-2 py-2 font-medium">
      <button
        onClick={onClick}
        className={cn('inline-flex items-center gap-1 transition-colors hover:text-fg-soft', active && 'text-cyan')}
      >
        {children}
      </button>
    </th>
  );
}

function MiniStat({
  label, value, sub, icon, tone = 'neutral',
}: {
  label: string; value?: number | string; sub?: string;
  icon?: React.ReactNode; tone?: 'neutral' | 'cyan' | 'rose' | 'emerald' | 'violet' | 'amber';
}) {
  const tones = {
    neutral: 'text-fg-soft', cyan: 'text-cyan', rose: 'text-rose',
    emerald: 'text-emerald', violet: 'text-violet', amber: 'text-amber',
  };
  return (
    <div className="glass-subtle rounded-xl px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-fg-mute">
        <span className={tones[tone]}>{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-[19px] font-semibold leading-none text-fg tabular">
        {value ?? '—'}
      </div>
      {sub && <div className="mt-1 text-[10.5px] text-fg-faint">{sub}</div>}
    </div>
  );
}

function Row({
  u, meId, onDetail, onEdit, onPwd, onDelete, onToggled,
}: {
  u: AdminUser; meId: number;
  onDetail: () => void; onEdit: () => void; onPwd: () => void; onDelete: () => void;
  onToggled: () => void;
}) {
  const pushToast = useApp((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const isMe = u.id === meId;

  const toggleStatus = async () => {
    setBusy(true);
    try {
      const next = u.status === 'active' ? 'disabled' : 'active';
      const r = await api.admin.update(u.id, { status: next });
      pushToast({
        kind: 'success',
        title: next === 'disabled' ? `已停用 ${u.username}` : `已恢复 ${u.username}`,
        desc: next === 'disabled' ? '该账号的所有登录会话已被踢下线' : undefined,
      });
      void r;
      onToggled();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '操作失败', desc: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-t border-hairline transition-colors hover:bg-veil/3">
      <td className="px-2 py-2.5">
        <button onClick={onDetail} className="flex items-center gap-2.5 text-left">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white/95"
            style={{ background: `linear-gradient(135deg, hsl(${u.avatarHue} 78% 58%), hsl(${(u.avatarHue + 60) % 360} 78% 52%))` }}
          >
            {(u.username || '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-fg">{u.username}</span>
            <span className="block truncate text-[11px] text-fg-mute">{u.email}</span>
          </span>
        </button>
      </td>
      <td className="px-2 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {u.role === 'admin' && <Badge tone="cyan"><ShieldCheck size={9} /> 管理员</Badge>}
          {u.status === 'disabled'
            ? <Badge tone="rose"><Ban size={9} /> 已停用</Badge>
            : <Badge tone="emerald">正常</Badge>}
          {isMe && <Badge tone="violet">我</Badge>}
        </div>
      </td>
      <td className="px-2 py-2.5 tabular text-fg-soft">
        {u.stats.attempts}
        <span className="ml-1 text-[11px] text-fg-faint">/ {u.stats.wrong} 错</span>
      </td>
      <td className="px-2 py-2.5">
        <div className="flex items-center gap-2">
          <span className="tabular text-fg-soft">{u.stats.accuracy}%</span>
          <span className="h-1 w-10 overflow-hidden rounded-full bg-veil/8">
            <span
              className={cn(
                'block h-full rounded-full',
                u.stats.accuracy >= 80 ? 'bg-emerald' : u.stats.accuracy >= 55 ? 'bg-cyan' : 'bg-amber',
              )}
              style={{ width: `${u.stats.accuracy}%` }}
            />
          </span>
        </div>
      </td>
      <td className="px-2 py-2.5 tabular text-fg-soft">
        {u.stats.xp}
        <span className="ml-1 text-[11px] text-fg-faint">Lv{u.stats.level}</span>
      </td>
      <td className="px-2 py-2.5 tabular text-fg-mute">{u.stats.cards}</td>
      <td className="px-2 py-2.5 text-fg-mute" title={u.lastLoginAt || '从未登录'}>
        {u.lastLoginAt ? relTime(u.lastLoginAt) : <span className="text-fg-faint">从未</span>}
      </td>
      <td className="px-2 py-2.5">
        <div className="flex items-center justify-end gap-1">
          <IconBtn label="编辑" onClick={onEdit}><Pencil size={13} /></IconBtn>
          <IconBtn label="重置密码" onClick={onPwd}><KeyRound size={13} /></IconBtn>
          <IconBtn
            label={u.status === 'active' ? '停用' : '恢复'}
            onClick={toggleStatus}
            disabled={isMe || busy}
            title={isMe ? '不能停用自己的账号' : undefined}
          >
            {busy ? <Loader2 size={13} className="animate-spin" />
              : u.status === 'active' ? <Ban size={13} /> : <CheckCircle2 size={13} />}
          </IconBtn>
          <IconBtn
            label="删除"
            onClick={onDelete}
            disabled={isMe}
            title={isMe ? '不能删除自己的账号' : undefined}
            danger
          >
            <Trash2 size={13} />
          </IconBtn>
        </div>
      </td>
    </tr>
  );
}

function IconBtn({
  children, label, onClick, disabled, danger, title,
}: {
  children: React.ReactNode; label: string; onClick: () => void;
  disabled?: boolean; danger?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title || label}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-lg border border-transparent text-fg-mute transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-35'
          : danger
            ? 'hover:border-rose/30 hover:bg-rose/12 hover:text-rose'
            : 'hover:border-hairline hover:bg-veil/7 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function LogList({ logs, loading }: { logs: AdminLogEntry[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-24 rounded-xl" />;
  if (!logs.length) {
    return <p className="py-6 text-center text-[12.5px] text-fg-faint">还没有任何管理操作记录。</p>;
  }
  const LABEL: Record<string, string> = {
    user_create: '新建用户',
    user_update: '修改用户',
    user_delete: '删除用户',
    password_reset: '重置密码',
    force_logout: '强制下线',
  };
  return (
    <div className="space-y-1.5">
      {logs.map((l) => (
        <div key={l.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-hairline bg-veil/2 px-3 py-2 text-[11.5px]">
          <Badge tone={l.action === 'user_delete' ? 'rose' : l.action === 'password_reset' ? 'amber' : 'neutral'}>
            {LABEL[l.action] || l.action}
          </Badge>
          <span className="text-fg-soft">{l.actorEmail}</span>
          <span className="text-fg-faint">→</span>
          <span className="text-fg-soft">{l.targetEmail || '（已删除）'}</span>
          {l.detail && Object.keys(l.detail).length > 0 && (
            <span className="min-w-0 flex-1 truncate text-fg-faint" title={JSON.stringify(l.detail)}>
              {describeDetail(l.detail)}
            </span>
          )}
          <span className="ml-auto shrink-0 text-fg-faint">
            <Clock size={10} className="mr-1 inline" />
            {relTime(l.at)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 把审计里的 detail 压成一行人话。改前→改后是关键信息，必须露出来。 */
function describeDetail(d: Record<string, unknown>): string {
  return Object.entries(d).map(([k, v]) => {
    if (Array.isArray(v) && v.length === 2) return `${k}: ${v[0] || '空'} → ${v[1] || '空'}`;
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      return Object.entries(o).map(([kk, vv]) => `${kk} ${vv}`).join('、');
    }
    return `${k}: ${v}`;
  }).join(' · ');
}

/* ============ 弹窗 ============ */

function CreateUserModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const pushToast = useApp((s) => s.pushToast);
  const [f, setF] = useState({ email: '', username: '', password: '', role: 'user', note: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setF({ email: '', username: '', password: '', role: 'user', note: '' });
  }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.admin.create(f);
      pushToast({ kind: 'success', title: `已创建 ${f.username}`, desc: '请把密码单独告诉他' });
      onDone();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '创建失败', desc: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建用户"
      desc="由管理员直接开号，跳过注册流程。"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={submit} loading={busy} disabled={!f.email || !f.username || f.password.length < 8}>
            <Plus size={13} /> 创建
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="邮箱" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="someone@example.com" />
          <Input label="昵称" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="最多 24 字" />
        </div>
        <Input
          label="初始密码"
          type="text"
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
          hint="至少 8 位，不能是纯数字或纯字母。明文显示，方便你直接抄给对方。"
          placeholder="例如 Kaoyan2027!"
        />
        <div>
          <div className="mb-2 text-[12.5px] font-medium text-fg-soft">角色</div>
          <Segmented
            value={f.role}
            onChange={(v) => setF({ ...f, role: v })}
            options={[
              { value: 'user', label: '普通用户' },
              { value: 'admin', label: '管理员' },
            ]}
          />
          {f.role === 'admin' && (
            <p className="mt-2 text-[11.5px] text-amber-200/90">
              管理员能看到全部账号信息、改角色、删账号。只给确实需要的人。
            </p>
          )}
        </div>
        <Input label="备注（可选）" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} hint="只有管理员看得到" />
      </div>
    </Modal>
  );
}

function EditUserModal({
  target, meId, onClose, onDone,
}: { target: AdminUser | null; meId: number; onClose: () => void; onDone: () => void }) {
  const pushToast = useApp((s) => s.pushToast);
  const [f, setF] = useState({ email: '', username: '', role: 'user', status: 'active', note: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setF({
        email: target.email, username: target.username, role: target.role,
        status: target.status, note: target.note || '',
      });
    }
  }, [target]);

  if (!target) return null;
  const isMe = target.id === meId;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.admin.update(target.id, f);
      const n = Object.keys(r.changed || {}).length;
      pushToast({ kind: 'success', title: n ? `已更新 ${n} 项` : '没有改动', desc: n ? '已记入审计日志' : undefined });
      onDone();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '更新失败', desc: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`编辑 ${target.username}`}
      desc={`${target.email} · 注册于 ${target.createdAt?.slice(0, 10)}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={submit} loading={busy}>保存</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="邮箱" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Input label="昵称" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        </div>

        <div>
          <div className="mb-2 text-[12.5px] font-medium text-fg-soft">角色</div>
          <Segmented
            value={f.role}
            onChange={(v) => setF({ ...f, role: v })}
            options={[
              { value: 'user', label: '普通用户' },
              { value: 'admin', label: '管理员' },
            ]}
          />
          {isMe && (
            <p className="mt-2 text-[11.5px] text-amber-200/90">
              这是你自己的账号 —— 服务端不允许自我降级，避免把自己关在门外。
            </p>
          )}
        </div>

        <div>
          <div className="mb-2 text-[12.5px] font-medium text-fg-soft">状态</div>
          <Segmented
            value={f.status}
            onChange={(v) => setF({ ...f, status: v })}
            options={[
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '停用' },
            ]}
          />
          {f.status === 'disabled' && target.status === 'active' && (
            <p className="mt-2 text-[11.5px] text-rose-200/90">
              停用会立刻注销该账号的全部登录会话，他手里的 cookie 当场失效。
            </p>
          )}
        </div>

        <Input label="备注" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} hint="只有管理员看得到，最长 500 字" />
      </div>
    </Modal>
  );
}

function ResetPasswordModal({ target, onClose, onDone }: { target: AdminUser | null; onClose: () => void; onDone: () => void }) {
  const pushToast = useApp((s) => s.pushToast);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (target) setPwd(''); }, [target]);
  if (!target) return null;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.admin.resetPassword(target.id, pwd);
      pushToast({
        kind: 'success',
        title: '密码已重置',
        desc: `已踢掉 ${r.sessionsKilled} 个登录会话，请把新密码单独告诉他`,
      });
      onDone();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '重置失败', desc: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`重置 ${target.username} 的密码`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={submit} loading={busy} disabled={pwd.length < 8}>确认重置</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-200/90">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            重置后该账号的**全部登录会话立即失效**，他必须用新密码重新登录。
            新密码不会出现在审计日志里，你得自己抄给他。
          </span>
        </div>
        <Input
          label="新密码"
          type="text"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          placeholder="至少 8 位"
          hint="明文显示 —— 你要把它交给本人，藏起来反而添麻烦"
        />
      </div>
    </Modal>
  );
}

function DeleteUserModal({ target, onClose, onDone }: { target: AdminUser | null; onClose: () => void; onDone: () => void }) {
  const pushToast = useApp((s) => s.pushToast);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (target) setTyped(''); }, [target]);
  if (!target) return null;

  const matched = typed.trim().toLowerCase() === target.email.toLowerCase();

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.admin.remove(target.id);
      const w = r.wiped || {};
      pushToast({
        kind: 'success',
        title: `已删除 ${target.username}`,
        desc: `连带清掉 ${w.attempts || 0} 条作答、${w.cards || 0} 张卡、${w.notes || 0} 条笔记`,
      });
      onDone();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '删除失败', desc: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="删除账号"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="danger" size="sm" onClick={submit} loading={busy} disabled={!matched}>
            <Trash2 size={13} /> 永久删除
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-xl border border-rose/28 bg-rose/8 px-3.5 py-3 text-[12.5px] leading-relaxed text-rose-100">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            会连同这个人的**全部学习数据**一起删除：作答明细、复习卡片、错题本、
            笔记、卡片库、成就与 XP。数据库外键是级联删除，删完不可恢复，
            也没有回收站。
          </span>
        </div>
        <div className="glass-subtle rounded-xl p-3.5 text-[12.5px]">
          <div className="grid grid-cols-2 gap-y-1.5 text-fg-mute">
            <span>账号</span><span className="text-fg-soft">{target.username}</span>
            <span>邮箱</span><span className="break-all text-fg-soft">{target.email}</span>
            <span>作答</span><span className="tabular text-fg-soft">{target.stats.attempts} 次</span>
            <span>复习卡</span><span className="tabular text-fg-soft">{target.stats.cards} 张</span>
          </div>
        </div>
        <Input
          label="输入邮箱确认"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={target.email}
          hint="手打一遍，防止点错行"
          error={typed && !matched ? '和上面的邮箱不一致' : undefined}
        />
      </div>
    </Modal>
  );
}

function UserDetailModal({
  id, meId, onClose, onChanged,
}: { id: number | null; meId: number; onClose: () => void; onChanged: () => void }) {
  const pushToast = useApp((s) => s.pushToast);
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kicking, setKicking] = useState(false);

  const load = useCallback(async (uid: number) => {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.admin.user(uid));
    } catch (e: any) {
      setErr(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!id) { setData(null); setErr(null); return; }
    void load(id);
  }, [id, load]);

  const forceLogout = async () => {
    if (!id) return;
    setKicking(true);
    try {
      const r = await api.admin.forceLogout(id);
      pushToast({
        kind: r.sessionsKilled ? 'success' : 'info',
        title: r.sessionsKilled ? `已踢掉 ${r.sessionsKilled} 个会话` : '该账号当前没有登录会话',
        desc: '本人需要重新登录',
      });
      await load(id);
      onChanged();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '操作失败', desc: e.message });
    } finally {
      setKicking(false);
    }
  };

  if (!id) return null;
  const u = data?.user;

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      size="lg"
      title={u ? `${u.username}${u.id === meId ? '（我）' : ''}` : '账号详情'}
      desc={u?.email}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={forceLogout}
            loading={kicking}
            disabled={!data?.sessions.length}
            title={data?.sessions.length ? undefined : '该账号当前没有登录会话'}
          >
            <LogOut size={13} /> 强制下线
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </>
      }
    >
      {loading && !data ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : err ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose/28 bg-rose/8 px-3.5 py-3 text-[12.5px] text-rose-100">
          <CircleAlert size={14} className="mt-0.5 shrink-0" /><span>{err}</span>
        </div>
      ) : data && u ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <DetailStat label="作答" value={u.stats.attempts} sub={`错 ${u.stats.wrong}`} />
            <DetailStat label="正确率" value={`${u.stats.accuracy}%`} sub={`对 ${u.stats.correct}`} />
            <DetailStat label="XP" value={u.stats.xp} sub={`Lv${u.stats.level} · ${u.stats.levelTitle}`} />
            <DetailStat label="累计时长" value={`${u.stats.minutes}`} sub={`分钟 · ${u.stats.activeDays} 天`} />
            <DetailStat label="复习卡" value={u.stats.cards} />
            <DetailStat label="卡片库" value={u.stats.deckCards} />
            <DetailStat label="成就" value={u.stats.achievements} />
            <DetailStat label="最高连击" value={u.stats.bestCombo} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="glass-subtle rounded-xl p-3.5 text-[12px]">
              <div className="mb-2 text-fg-soft">账号信息</div>
              <KV k="角色" v={u.role === 'admin' ? '管理员' : '普通用户'} />
              <KV k="状态" v={u.status === 'active' ? '正常' : '已停用'} />
              <KV k="注册" v={u.createdAt?.slice(0, 19).replace('T', ' ')} />
              <KV k="最近登录" v={u.lastLoginAt ? u.lastLoginAt.slice(0, 19).replace('T', ' ') : '从未登录'} />
              <KV k="备注" v={u.note || '—'} />
            </div>
            <div className="glass-subtle rounded-xl p-3.5 text-[12px]">
              <div className="mb-2 text-fg-soft">备考设置</div>
              {data.settings ? (
                <>
                  <KV k="考试范围" v={data.settings.examTrack} />
                  <KV k="每日新学" v={`${data.settings.dailyNew} 个`} />
                  <KV k="考试日期" v={data.settings.examDate || '未设置'} />
                  <KV k="AI 人格" v={data.settings.persona} />
                  <KV k="外观主题" v={data.settings.theme} />
                </>
              ) : <p className="text-fg-mute">暂无</p>}
            </div>
          </div>

          <div className="glass-subtle rounded-xl p-3.5 text-[12px]">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-fg-soft">模型接入</span>
              <span className="text-fg-faint">
                只看配置状态 —— 别人用哪家模型、密钥是什么，不属于管理范围
              </span>
            </div>
            {data.llm ? (
              <KV
                k="配置"
                v={data.llm.enabled
                  ? `${data.llm.kind === 'local' ? '本地' : '云端'} · ${data.llm.model || '未填模型名'}${data.llm.hasKey ? ' · 已配密钥' : ''}`
                  : '未启用'}
              />
            ) : <p className="text-fg-mute">暂无</p>}
          </div>

          <div className="glass-subtle rounded-xl p-3.5">
            <div className="mb-2 text-[12px] text-fg-soft">活跃设备（{data.sessions.length}）</div>
            {data.sessions.length === 0 ? (
              <p className="text-[12px] text-fg-mute">没有有效登录会话。</p>
            ) : (
              <div className="space-y-1.5">
                {data.sessions.slice(0, 6).map((s, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg border border-hairline bg-veil/2 px-2.5 py-1.5 text-[11.5px]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald" />
                    <span className="min-w-0 flex-1 truncate text-fg-soft">{s.user_agent || '未知设备'}</span>
                    <span className="shrink-0 text-fg-faint">{s.ip}</span>
                    <span className="shrink-0 text-fg-faint">{s.last_seen_at?.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass-subtle rounded-xl p-3.5">
            <div className="mb-2 text-[12px] text-fg-soft">近 30 天作答（{data.daily.length} 天有记录）</div>
            {data.daily.length === 0 ? (
              <p className="text-[12px] text-fg-mute">还没有作答记录。</p>
            ) : (
              <div className="flex h-14 items-end gap-[3px]">
                {data.daily.map((d) => {
                  const max = Math.max(...data.daily.map((x) => x.n), 1);
                  return (
                    <div
                      key={d.date}
                      title={`${d.date}：${d.n} 题，对 ${d.c}`}
                      className="min-w-[4px] flex-1 rounded-t bg-cyan/55"
                      style={{ height: `${Math.max(6, (d.n / max) * 100)}%` }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {data.logs.length > 0 && (
            <div className="glass-subtle rounded-xl p-3.5">
              <div className="mb-2 text-[12px] text-fg-soft">这个账号被管理过的记录</div>
              <div className="space-y-1.5">
                {data.logs.slice(0, 8).map((l) => (
                  <div key={l.id} className="flex items-center gap-2 text-[11.5px]">
                    <span className="text-fg-soft">{l.actor_email}</span>
                    <span className="text-fg-mute">{l.action}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-faint">{describeDetail(l.detail)}</span>
                    <span className="shrink-0 text-fg-faint">{relTime(l.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-fg-faint">
            出于隐私边界，这里不展示他的作答题目、笔记正文与对话内容 ——
            管理看的是"有多少"，不是"是什么"。
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

function DetailStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-veil/3 px-3 py-2.5">
      <div className="text-[10.5px] text-fg-mute">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold leading-none text-fg tabular">{value}</div>
      {sub && <div className="mt-1 truncate text-[10.5px] text-fg-faint">{sub}</div>}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-20 shrink-0 text-fg-mute">{k}</span>
      <span className="min-w-0 flex-1 break-words text-fg-soft">{v}</span>
    </div>
  );
}
