import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  BookOpen, Eraser, Lightbulb, MessagesSquare, Send, Sparkles, Square,
  Wand2, Zap,
} from 'lucide-react';
import { api, streamChat, type ChatMessage } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, Badge, EmptyState, Skeleton, Segmented } from '@/components/ui/Primitives';
import { RichText } from '@/components/ui/Math';
import { announceAchievements } from '@/components/ui/Toaster';
import { cn } from '@/lib/utils';

const PERSONAS = [
  { value: 'strict', label: '严师' },
  { value: 'socratic', label: '苏格拉底' },
  { value: 'warm', label: '暖师' },
  { value: 'exam', label: '命题人' },
];

const QUICK = [
  { text: '举个例子', icon: Lightbulb },
  { text: '出个题考我', icon: Zap },
  { text: '我没听懂，换个说法', icon: Wand2 },
  { text: '我学会了', icon: Sparkles },
];

export default function Chat() {
  const [params, setParams] = useSearchParams();
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);

  const tree = useAsync(() => api.catalog.tree('math1'), [], { key: 'catalog.tree:math1' });
  const settings = useAsync(() => api.settings.llm(), [], { key: 'settings.llm' });

  const [kid, setKid] = useState(params.get('kid') || '');
  const [persona, setPersona] = useState('strict');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const nodes = useMemo(() => {
    const out: { id: string; title: string; category: string }[] = [];
    tree.data?.categories.forEach((c) => {
      c.chapters.forEach((ch) => {
        ch.nodes.forEach((n) => out.push({ id: n.id, title: n.title, category: c.name }));
      });
    });
    return out;
  }, [tree.data]);

  const current = nodes.find((n) => n.id === kid);
  const llmReady = !!settings.data?.llm?.hasKey || settings.data?.llm?.kind === 'local';

  // 载入历史
  useEffect(() => {
    if (!kid) { setMessages([]); return; }
    api.chat.get(kid).then((r) => {
      setMessages(r.chat?.history?.length ? r.chat.history : []);
    }).catch(() => setMessages([]));
  }, [kid]);

  // 滚动到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const persist = useCallback((msgs: ChatMessage[], k: string) => {
    if (!k || !msgs.length) return;
    api.chat.save(k, 'explain', msgs).catch(() => {});
  }, []);

  const send = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    if (!kid) {
      pushToast({ kind: 'warn', title: '先选一个知识点', desc: '对话要围绕具体考点，不然 AI 不知道该讲多深' });
      return;
    }
    if (!llmReady) {
      pushToast({ kind: 'warn', title: '还没配置模型', desc: '去「设置 → 模型接入」填一个 Base URL 和模型名' });
      return;
    }

    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    abortRef.current = streamChat(
      { kid, stage: 'explain', persona, messages: next },
      {
        onDelta: (d) => {
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { role: 'assistant', content: last.content + d };
            return copy;
          });
        },
        onDone: (full) => {
          setStreaming(false);
          abortRef.current = null;
          setMessages((m) => {
            const final = [...m];
            final[final.length - 1] = { role: 'assistant', content: full };
            persist(final, kid);
            return final;
          });
        },
        onError: (msg) => {
          setStreaming(false);
          abortRef.current = null;
          setMessages((m) => m.slice(0, -1));
          pushToast({ kind: 'error', title: '对话失败', desc: msg });
        },
      },
    );
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
  };

  const clear = async () => {
    if (!kid) return;
    await api.chat.save(kid, 'explain', []).catch(() => {});
    setMessages([]);
    pushToast({ kind: 'info', title: '对话已清空' });
  };

  const extract = async () => {
    const text = messages.map((m) => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`).join('\n\n');
    if (!text.trim()) {
      pushToast({ kind: 'warn', title: '还没有对话内容' });
      return;
    }
    setExtracting(true);
    try {
      const r = await api.ai.extract(text, kid);
      if (r.cards?.length) {
        pushToast({ kind: 'success', title: `提取了 ${r.cards.length} 张卡片`, desc: '已存进卡片库' });
        refreshSnapshot();
      } else {
        pushToast({ kind: 'warn', title: '这次没提取到值得复习的内容', desc: r.raw ? r.raw.slice(0, 80) : undefined });
      }
    } catch (e: any) {
      pushToast({ kind: 'error', title: '提取失败', desc: e?.message });
    } finally {
      setExtracting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (tree.loading && !tree.data) {
    return <div className="space-y-4"><Skeleton className="h-[64px] rounded-2xl" /><Skeleton className="h-[440px] rounded-2xl" /></div>;
  }

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[520px] flex-col gap-4">
      {/* 顶部控制 */}
      <Panel className="shrink-0 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cyan/25 bg-cyan/10 text-cyan">
            <MessagesSquare size={16} />
          </div>

          <div className="min-w-[200px] flex-1">
            <select
              value={kid}
              onChange={(e) => { setKid(e.target.value); setParams(e.target.value ? { kid: e.target.value } : {}); }}
              className="h-9 w-full rounded-xl border border-hairline bg-ink-850 px-3 text-[13px] text-fg outline-none transition-colors focus:border-cyan/45"
            >
              <option value="">选择要学的知识点…</option>
              {tree.data?.categories.map((c) => (
                <optgroup key={c.id} label={c.name}>
                  {c.chapters.flatMap((ch) => ch.nodes).map((n) => (
                    <option key={n.id} value={n.id}>{n.title}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <Segmented
            size="sm"
            value={persona}
            onChange={setPersona}
            options={PERSONAS.map((p) => ({ value: p.value, label: p.label }))}
          />

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={extract} loading={extracting} disabled={!messages.length}>
              <Sparkles size={13} /> 提取知识点
            </Button>
            <Button variant="ghost" size="sm" onClick={clear} disabled={!messages.length} aria-label="清空对话">
              <Eraser size={13} />
            </Button>
          </div>
        </div>

        {current && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-mute">
            <Badge tone="cyan">{current.category}</Badge>
            <span>{current.title}</span>
            <span className="text-fg-faint">·</span>
            <span>系统已注入你的实时学情，AI 知道你这个考点错了几次</span>
          </div>
        )}
      </Panel>

      {/* 消息区 */}
      <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={<BookOpen size={22} />}
                title={kid ? '开始聊吧' : '先选一个知识点'}
                desc={kid
                  ? '它会先问你，而不是直接告诉你答案 —— 这是故意的。'
                  : '选好考点后，AI 会围绕它跟你对话。不选的话它不知道该讲多深。'}
                className="py-0"
              />
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((m, i) => (
                <MessageBubble key={i} role={m.role} content={m.content} streaming={streaming && i === messages.length - 1} />
              ))}
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t border-hairline p-3.5">
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <button
                key={q.text}
                onClick={() => send(q.text)}
                disabled={streaming || !kid}
                className="flex items-center gap-1.5 rounded-lg border border-veil/8 bg-veil/4 px-2.5 py-1.5 text-[11.5px] text-fg-soft transition-all duration-200 hover:border-cyan/30 hover:bg-veil/7 disabled:opacity-40"
              >
                <q.icon size={11} />
                {q.text}
              </button>
            ))}
          </div>

          <div className="flex items-end gap-2.5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={kid ? '把你的疑问打出来，Enter 发送，Shift+Enter 换行' : '先在上面选一个知识点'}
              disabled={!kid}
              className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-hairline bg-veil/4 px-3.5 py-3 text-[13.5px] leading-relaxed text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45 focus:bg-veil/6 disabled:opacity-50"
            />
            {streaming ? (
              <Button variant="danger" onClick={stop} className="h-11">
                <Square size={14} /> 停止
              </Button>
            ) : (
              <Button onClick={() => send()} disabled={!input.trim() || !kid} className="h-11">
                <Send size={15} />
              </Button>
            )}
          </div>

          {!llmReady && (
            <p className="mt-2 text-[11.5px] text-amber-300/85">
              还没配置模型 —— 去「设置 → 模型接入」填 Base URL 与模型名即可开始对话。
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}

function MessageBubble({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
  const isUser = role === 'user';
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={cn('flex gap-3', isUser && 'flex-row-reverse')}
    >
      <div
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-xl border text-[11px] font-semibold',
          isUser
            ? 'border-veil/10 bg-veil/6 text-fg-soft'
            : 'border-cyan/25 bg-cyan/10 text-cyan',
        )}
      >
        {isUser ? '我' : '师'}
      </div>

      <div
        className={cn(
          'max-w-[82%] rounded-2xl px-4 py-3 text-[13.5px] leading-[1.85]',
          isUser
            ? 'border border-veil/8 bg-veil/6 text-fg'
            : 'border border-hairline bg-veil/3 text-fg-soft',
        )}
      >
        {content ? (
          <RichText text={content} />
        ) : (
          <span className="flex items-center gap-1.5 text-fg-mute">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan" style={{ animationDelay: '0ms' }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan" style={{ animationDelay: '150ms' }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan" style={{ animationDelay: '300ms' }} />
          </span>
        )}
        {streaming && content && (
          <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-cyan align-middle" />
        )}
      </div>
    </motion.div>
  );
}

export { AnimatePresence };
