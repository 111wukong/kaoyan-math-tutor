import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle, Check, Database, Download, HardDrive, KeyRound, Loader2,
  Monitor, Palette, Plug, RotateCcw, Save, Shield, Trash2, Upload, User, X,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/theme';
import { Panel, Button, Input, SectionTitle, Badge, Segmented, Skeleton, Divider } from '@/components/ui/Primitives';
import { ThemePicker } from '@/components/ui/ThemePicker';
import { Modal } from '@/components/ui/Modal';
import { cn, copyText } from '@/lib/utils';

const TRACKS = [
  { value: 'math1', label: '数学一' },
  { value: 'math2', label: '数学二' },
  { value: 'math3', label: '数学三' },
];

export default function Settings() {
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);
  const user = useAuth((s) => s.user);
  const { theme, setTheme } = useTheme();

  const settings = useAsync(() => api.settings.get(), [], { key: 'settings' });
  const llm = useAsync(() => api.settings.llm(), [], { key: 'settings.llm' });
  const storage = useAsync(() => api.data.storage(), [], { key: 'data.storage' });
  const sessions = useAsync(() => api.auth.sessions(), [], { key: 'auth.sessions' });

  const [savingSettings, setSavingSettings] = useState(false);
  const [form, setForm] = useState<Record<string, any> | null>(null);
  const [llmForm, setLlmForm] = useState<Record<string, any> | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [savingLlm, setSavingLlm] = useState(false);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' });
  const [pwdBusy, setPwdBusy] = useState(false);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deletePwd, setDeletePwd] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [importBundle, setImportBundle] = useState<any>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importBusy, setImportBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const s = form ?? (settings.data?.settings ? {
    examTrack: settings.data.settings.examTrack,
    dailyNew: settings.data.settings.dailyNew,
    examDate: settings.data.settings.examDate,
    persona: settings.data.settings.persona,
    sfx: settings.data.settings.sfx,
  } : null);

  const l = llmForm ?? (llm.data?.llm ? {
    enabled: llm.data.llm.enabled,
    kind: llm.data.llm.kind,
    localBase: llm.data.llm.localBase,
    localModel: llm.data.llm.localModel,
    cloudBase: llm.data.llm.cloudBase,
    cloudModel: llm.data.llm.cloudModel,
    cloudKey: '',
    rememberKey: llm.data.llm.rememberKey,
    hasKey: llm.data.llm.hasKey,
    keyPreview: llm.data.llm.keyPreview,
  } : null);

  const saveSettings = async () => {
    if (!s) return;
    setSavingSettings(true);
    try {
      await api.settings.update(s);
      setForm(null);
      settings.reload();
      refreshSnapshot();
      pushToast({ kind: 'success', title: '设置已保存' });
    } catch (e: any) {
      pushToast({ kind: 'error', title: '保存失败', desc: e.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveLlm = async () => {
    if (!l) return;
    setSavingLlm(true);
    try {
      await api.settings.updateLlm(l);
      setLlmForm(null);
      llm.reload();
      pushToast({ kind: 'success', title: '模型配置已保存' });
    } catch (e: any) {
      pushToast({ kind: 'error', title: '保存失败', desc: e.message });
    } finally {
      setSavingLlm(false);
    }
  };

  const testLlm = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.settings.testLlm();
      setTestResult(r);
      if (r.ok) pushToast({ kind: 'success', title: `连接正常（${r.ms}ms）` });
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const changePwd = async () => {
    if (pwd.next !== pwd.confirm) { pushToast({ kind: 'warn', title: '两次新密码不一致' }); return; }
    if (pwd.next.length < 8) { pushToast({ kind: 'warn', title: '新密码至少 8 位' }); return; }
    setPwdBusy(true);
    try {
      await api.auth.changePassword(pwd.current, pwd.next);
      pushToast({ kind: 'success', title: '密码已修改', desc: '其它设备已被登出' });
      setPwdOpen(false);
      setPwd({ current: '', next: '', confirm: '' });
      sessions.reload();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '修改失败', desc: e.message });
    } finally {
      setPwdBusy(false);
    }
  };

  const doExport = async (withKey: boolean) => {
    try {
      const bundle = await api.data.export(withKey);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `研数备份-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      pushToast({ kind: 'success', title: '备份已下载', desc: withKey ? '含 API Key，注意保管' : '已剥掉 API Key' });
    } catch (e: any) {
      pushToast({ kind: 'error', title: '导出失败', desc: e.message });
    }
  };

  const pickFile = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const bundle = JSON.parse(text);
      if (bundle.app !== 'kaoyan-math-tutor') {
        pushToast({ kind: 'error', title: '这不是研数的备份文件' });
        return;
      }
      setImportBundle(bundle);
      setImportOpen(true);
    } catch {
      pushToast({ kind: 'error', title: '文件解析失败', desc: '可能不是合法的 JSON' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doImport = async () => {
    if (!importBundle) return;
    setImportBusy(true);
    try {
      const r = await api.data.import(importBundle, importMode);
      pushToast({
        kind: 'success',
        title: `导入完成（${importMode === 'merge' ? '合并' : '覆盖'}）`,
        desc: `作答 +${r.summary.attempts} · 卡片 +${r.summary.cards} · 笔记 +${r.summary.notes}`,
      });
      setImportOpen(false);
      setImportBundle(null);
      storage.reload();
      refreshSnapshot();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '导入失败', desc: e.message });
    } finally {
      setImportBusy(false);
    }
  };

  const doReset = async () => {
    setResetBusy(true);
    try {
      await api.study.reset();
      pushToast({ kind: 'success', title: '学习数据已重置', desc: '账号与设置保留' });
      setResetOpen(false);
      storage.reload();
      refreshSnapshot();
    } catch (e: any) {
      pushToast({ kind: 'error', title: '重置失败', desc: e.message });
    } finally {
      setResetBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.auth.deleteAccount(deletePwd);
      pushToast({ kind: 'success', title: '账号已注销' });
      window.location.href = '/login';
    } catch (e: any) {
      pushToast({ kind: 'error', title: '注销失败', desc: e.message });
      setDeleteBusy(false);
    }
  };

  const loading = (settings.loading && !settings.data) || (llm.loading && !llm.data);

  if (loading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[180px] rounded-2xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 外观。放在第一块 —— 这是唯一"改完立刻看得见"的设置，
          也是新用户最可能想动的一项。 */}
      <Panel className="p-5">
        <SectionTitle
          title="外观"
          desc="选完立即生效，并且跟着账号走 —— 换台设备登录还是这套配色。"
          right={
            <Badge tone={theme.mode === 'light' ? 'amber' : 'cyan'}>
              <Palette size={10} /> 当前：{theme.name}
            </Badge>
          }
          className="mb-4"
        />
        <ThemePicker />
        <p className="mt-3.5 text-[11.5px] leading-relaxed text-fg-mute">
          暗色主题带动态背景（赛博网格 + 星尘），亮色主题走静态纸面 ——
          霓虹网格画在白纸上既不像纸也不像夜，所以亮色下那两层不挂载。
        </p>
      </Panel>

      {/* 备考设置 */}
      <Panel className="p-5">
        <SectionTitle title="备考设置" desc="影响调度器的权重与每日任务量" className="mb-4" />
        {s && (
          <div className="space-y-5">
            <div>
              <div className="mb-2 text-[12.5px] font-medium text-fg-soft">考试范围</div>
              <Segmented
                value={s.examTrack}
                onChange={(v) => setForm({ ...s, examTrack: v })}
                options={TRACKS}
              />
              <p className="mt-2 text-[11.5px] text-fg-mute">
                数一覆盖面最大，切换后知识树与统计都会按新范围重算。
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="每日新学知识点"
                type="number"
                min={1}
                max={20}
                value={s.dailyNew}
                onChange={(e) => setForm({ ...s, dailyNew: Number(e.target.value) })}
                hint="冲刺期建议 1-2 个，保证复习量能跟上"
              />
              <Input
                label="考试日期"
                type="date"
                value={s.examDate || ''}
                onChange={(e) => setForm({ ...s, examDate: e.target.value })}
                hint="用来算倒计时和备考投影"
              />
            </div>

            <div>
              <div className="mb-2 text-[12.5px] font-medium text-fg-soft">AI 老师人格</div>
              <Segmented
                value={s.persona}
                onChange={(v) => setForm({ ...s, persona: v })}
                options={[
                  { value: 'strict', label: '严师' },
                  { value: 'socratic', label: '苏格拉底' },
                  { value: 'warm', label: '暖师' },
                  { value: 'exam', label: '命题人' },
                ]}
              />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-veil/7 bg-veil/3 px-4 py-3">
              <div>
                <div className="text-[13px] text-fg-soft">音效</div>
                <div className="mt-0.5 text-[11.5px] text-fg-mute">答对随连击升调，答错短促下行</div>
              </div>
              <button
                onClick={() => setForm({ ...s, sfx: !s.sfx })}
                className={cn(
                  'relative h-6 w-11 rounded-full transition-colors duration-250',
                  s.sfx ? 'bg-cyan/70' : 'bg-veil/12',
                )}
                role="switch"
                aria-checked={s.sfx}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-250',
                    s.sfx ? 'translate-x-[22px]' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>

            <div className="flex justify-end">
              <Button onClick={saveSettings} loading={savingSettings} disabled={!form}>
                <Save size={14} /> 保存设置
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {/* 模型接入 */}
      <Panel className="p-5">
        <SectionTitle
          title="模型接入"
          desc="任何 OpenAI 兼容接口都能用。Key 存在你自己的数据库里，不会发给第三方。"
          right={
            <Badge tone={l?.hasKey || l?.kind === 'local' ? 'emerald' : 'amber'}>
              <Plug size={10} /> {l?.hasKey ? '已配置密钥' : l?.kind === 'local' ? '本地模型' : '未配置'}
            </Badge>
          }
          className="mb-4"
        />

        {l && (
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-[12.5px] font-medium text-fg-soft">通道</div>
              <Segmented
                value={l.kind}
                onChange={(v) => setLlmForm({ ...l, kind: v })}
                options={[
                  { value: 'cloud', label: '云端 API' },
                  { value: 'local', label: '本地模型' },
                ]}
              />
            </div>

            {l.kind === 'cloud' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Base URL"
                  placeholder="https://api.deepseek.com"
                  value={l.cloudBase}
                  onChange={(e) => setLlmForm({ ...l, cloudBase: e.target.value })}
                  hint="不要带 /chat/completions"
                />
                <Input
                  label="模型名"
                  placeholder="deepseek-chat"
                  value={l.cloudModel}
                  onChange={(e) => setLlmForm({ ...l, cloudModel: e.target.value })}
                />
                <div className="sm:col-span-2">
                  <Input
                    label="API Key"
                    type="password"
                    placeholder={l.hasKey ? `当前：${l.keyPreview}（留空则不修改）` : 'sk-...'}
                    value={l.cloudKey}
                    onChange={(e) => setLlmForm({ ...l, cloudKey: e.target.value })}
                    icon={<KeyRound size={14} />}
                    hint="留空保持原值；想清空请到「数据」区重置配置"
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="本地服务地址"
                  placeholder="http://127.0.0.1:1234/v1"
                  value={l.localBase}
                  onChange={(e) => setLlmForm({ ...l, localBase: e.target.value })}
                  hint="LM Studio / Ollama / vLLM 都行"
                />
                <Input
                  label="模型名"
                  placeholder="qwen2.5-7b-instruct"
                  value={l.localModel}
                  onChange={(e) => setLlmForm({ ...l, localModel: e.target.value })}
                />
              </div>
            )}

            {testResult && (
              <div
                className={cn(
                  'flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12.5px]',
                  testResult.ok ? 'border-emerald/28 bg-emerald/8 text-emerald-100' : 'border-rose/28 bg-rose/8 text-rose-100',
                )}
              >
                {testResult.ok ? <Check size={14} className="mt-0.5 shrink-0" /> : <X size={14} className="mt-0.5 shrink-0" />}
                <div>
                  {testResult.ok
                    ? <>连接正常 · {testResult.ms}ms · 模型 <span className="font-mono">{testResult.model}</span>
                      {testResult.reply && <div className="mt-1 opacity-80">模型回：{testResult.reply}</div>}
                    </>
                    : <>{testResult.error || '连接失败'}</>}
                </div>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2.5">
              <Button variant="outline" onClick={testLlm} loading={testing}>
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} 测试连接
              </Button>
              <Button onClick={saveLlm} loading={savingLlm} disabled={!llmForm}>
                <Save size={14} /> 保存配置
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {/* 账号 */}
      <Panel className="p-5">
        <SectionTitle title="账号" desc={`${user?.email} · 注册于 ${user?.createdAt?.slice(0, 10)}`} className="mb-4" />
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-veil/7 bg-veil/3 px-4 py-3">
            <div className="flex items-center gap-3">
              <User size={16} className="text-fg-mute" />
              <div>
                <div className="text-[13px] text-fg-soft">登录密码</div>
                <div className="mt-0.5 text-[11.5px] text-fg-mute">修改后其它设备会被强制登出</div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPwdOpen(true)}>修改密码</Button>
          </div>

          <div className="rounded-xl border border-veil/7 bg-veil/3 px-4 py-3">
            <div className="mb-2.5 flex items-center gap-3">
              <Monitor size={16} className="text-fg-mute" />
              <div>
                <div className="text-[13px] text-fg-soft">活跃会话</div>
                <div className="mt-0.5 text-[11.5px] text-fg-mute">
                  当前 {sessions.data?.count ?? 0} 个设备持有有效登录态
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              {(sessions.data?.sessions || []).slice(0, 5).map((x: any, i: number) => (
                <div key={i} className="flex items-center gap-2.5 rounded-lg border border-veil/6 bg-veil/2 px-3 py-2 text-[11.5px]">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald" />
                  <span className="min-w-0 flex-1 truncate text-fg-soft">{x.user_agent || '未知设备'}</span>
                  <span className="shrink-0 text-fg-faint">{x.ip}</span>
                  <span className="shrink-0 text-fg-faint">{x.last_seen_at?.slice(0, 16).replace('T', ' ')}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose/22 bg-rose/6 px-4 py-3">
            <div className="flex items-center gap-3">
              <Trash2 size={16} className="text-rose" />
              <div>
                <div className="text-[13px] text-rose-100">注销账号</div>
                <div className="mt-0.5 text-[11.5px] text-rose-200/70">会连同全部学习数据一起删除，不可恢复</div>
              </div>
            </div>
            <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>注销账号</Button>
          </div>
        </div>
      </Panel>

      {/* 数据 */}
      <Panel className="p-5">
        <SectionTitle
          title="数据与备份"
          desc="所有数据在服务端的 SQLite 里，备份就是一个 JSON 文件"
          right={
            storage.data ? (
              <Badge tone="neutral">
                <HardDrive size={10} /> {storage.data.dbMb} MB
              </Badge>
            ) : undefined
          }
          className="mb-4"
        />

        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: '作答明细', v: storage.data?.attempts },
            { label: '复习卡片', v: storage.data?.cards },
            { label: '笔记', v: storage.data?.notes },
            { label: '卡片库', v: storage.data?.deck },
          ].map((x) => (
            <div key={x.label} className="glass-subtle rounded-xl px-3.5 py-3">
              <div className="text-[19px] font-semibold text-fg tabular">{x.v ?? '—'}</div>
              <div className="mt-0.5 text-[11px] text-fg-mute">{x.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2.5">
          <Button variant="outline" onClick={() => doExport(false)}>
            <Download size={14} /> 导出备份（脱敏）
          </Button>
          <Button variant="ghost" size="md" onClick={() => doExport(true)} title="包含 API Key，谨慎保管">
            <Shield size={14} /> 含密钥导出
          </Button>
          <Button variant="outline" onClick={pickFile}>
            <Upload size={14} /> 导入备份
          </Button>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} className="hidden" />
        </div>

        <Divider className="my-4" />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-fg-mute">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber" />
            <span>重置只清空学习数据（作答、卡片、错题、成就），账号和模型配置保留。</span>
          </div>
          <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>
            <RotateCcw size={13} /> 重置学习数据
          </Button>
        </div>
      </Panel>

      {/* 关于 */}
      <Panel className="p-5">
        <SectionTitle title="关于" className="mb-3" />
        <div className="grid gap-3 text-[12px] sm:grid-cols-2">
          <InfoRow icon={<Database size={13} />} label="存储" value="SQLite（服务端，单文件）" />
          <InfoRow icon={<Shield size={13} />} label="密码" value="scrypt 派生 + 随机盐" />
          <InfoRow icon={<Plug size={13} />} label="会话" value="httpOnly Cookie + 服务端会话表" />
          <InfoRow icon={<HardDrive size={13} />} label="版本" value="2.0.0（全栈重构版）" />
        </div>
        <div className="mt-4 flex items-center gap-2 text-[11.5px] text-fg-faint">
          <span>数据库路径可在服务端日志里看到 · </span>
          <button
            onClick={async () => {
              const ok = await copyText('server/data/app.db');
              pushToast({ kind: ok ? 'success' : 'error', title: ok ? '路径已复制' : '复制失败' });
            }}
            className="text-cyan hover:text-cyan-200"
          >
            复制相对路径
          </button>
        </div>
      </Panel>

      {/* 改密 */}
      <Modal
        open={pwdOpen}
        onClose={() => setPwdOpen(false)}
        title="修改密码"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPwdOpen(false)}>取消</Button>
            <Button size="sm" onClick={changePwd} loading={pwdBusy}>确认修改</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="当前密码" type="password" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} />
          <Input label="新密码" type="password" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} hint="至少 8 位" />
          <Input
            label="确认新密码"
            type="password"
            value={pwd.confirm}
            onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
            error={pwd.confirm && pwd.confirm !== pwd.next ? '两次输入不一致' : undefined}
          />
        </div>
      </Modal>

      {/* 重置确认 */}
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="重置学习数据"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>取消</Button>
            <Button variant="danger" size="sm" onClick={doReset} loading={resetBusy}>确认重置</Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed text-fg-soft">
          <p>会清空：全部作答记录、复习卡片、错题本、笔记、卡片库、打卡与成就、XP 等级。</p>
          <p className="text-amber-200/90">保留：账号、密码、模型配置、考试设置。</p>
          <p className="text-fg-mute">建议先导出备份 —— 这一步不可撤销。</p>
        </div>
      </Modal>

      {/* 注销确认 */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="注销账号"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button variant="danger" size="sm" onClick={doDelete} loading={deleteBusy} disabled={!deletePwd}>永久删除</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-rose/28 bg-rose/8 px-3.5 py-3 text-[12.5px] leading-relaxed text-rose-100">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>这会删除账号和全部学习数据，包括所有作答记录、卡片、成就。不可恢复。</span>
          </div>
          <Input
            label="输入密码确认"
            type="password"
            value={deletePwd}
            onChange={(e) => setDeletePwd(e.target.value)}
            placeholder="你的登录密码"
          />
        </div>
      </Modal>

      {/* 导入确认 */}
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="导入备份"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(false)}>取消</Button>
            <Button size="sm" onClick={doImport} loading={importBusy}>开始导入</Button>
          </>
        }
      >
        {importBundle && (
          <div className="space-y-4">
            <div className="glass-subtle rounded-xl p-3.5 text-[12.5px]">
              <div className="mb-2 text-fg-soft">备份内容</div>
              <div className="grid grid-cols-2 gap-y-1.5 text-fg-mute">
                <span>导出时间</span><span className="text-fg-soft">{importBundle.exportedAt?.slice(0, 19).replace('T', ' ')}</span>
                <span>作答记录</span><span className="text-fg-soft tabular">{importBundle.data?.attempts?.length ?? 0}</span>
                <span>复习卡片</span><span className="text-fg-soft tabular">{importBundle.data?.cards?.length ?? 0}</span>
                <span>笔记</span><span className="text-fg-soft tabular">{importBundle.data?.notes?.length ?? 0}</span>
                <span>卡片库</span><span className="text-fg-soft tabular">{importBundle.data?.deck?.length ?? 0}</span>
              </div>
              {importBundle.keyStripped && (
                <p className="mt-2.5 text-[11.5px] text-emerald-200/85">该备份已剥掉 API Key，导入不会覆盖你的模型配置</p>
              )}
            </div>

            <div>
              <div className="mb-2 text-[12.5px] font-medium text-fg-soft">导入方式</div>
              <Segmented
                value={importMode}
                onChange={setImportMode}
                options={[
                  { value: 'merge', label: '合并（推荐）' },
                  { value: 'replace', label: '覆盖' },
                ]}
              />
              <p className="mt-2 text-[11.5px] leading-relaxed text-fg-mute">
                {importMode === 'merge'
                  ? '只增不减：作答按 ID 去重取并集，卡片取复习进度更靠后的那次，XP 取更大值。'
                  : '清空当前全部学习数据，完全替换为备份里的内容。模型配置会保留。'}
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-veil/6 bg-veil/2 px-3 py-2">
      <span className="text-fg-faint">{icon}</span>
      <span className="text-fg-mute">{label}</span>
      <span className="ml-auto text-fg-soft">{value}</span>
    </div>
  );
}

export { motion };
