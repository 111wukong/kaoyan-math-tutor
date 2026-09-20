import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Eye, Lightbulb, ListChecks, RotateCcw, X, Zap } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui/Primitives';
import { InlineMath, RichText } from '@/components/ui/Math';
import { cn, DIFFICULTY } from '@/lib/utils';
import { sfxCorrect, sfxWrong } from '@/lib/sfx';
import type { AnswerResult, Question } from '@/lib/api';

/* 单题作答卡
 *
 * 交互链路：作答 → 判分 → 反馈（对错 + 解析 + XP）→ 下一题
 * 键盘：1-4 选选项，Enter 提交，Enter 再按一次进入下一题 —— 刷题时不该离开键盘。
 *
 * ── 六种题型，三种作答形态 ─────────────────────────────────────────
 *   点选：单选(choice) / 多选(multi) / 判断(judge)
 *   输入：填空(blank)
 *   书写：解答(solve) / 证明(proof)
 *
 * 前两种机器能判，第三种不能 —— 所以解答题多一步「亮答案 → 自评」。
 * 这一步不是偷懒，是唯一诚实的做法：数学过程对不对，字符串比对判不了，
 * 而假判（比如拿最终答案去比）会让「思路对但答案写错」和「完全不会」
 * 记成同一笔账，错题本和掌握度都会失真。
 *
 * ★ 自评是**两步**，界面上必须看得出区别：
 *   第一步返回的 correct 是 null（还没判），不是 false（答错了）。
 *   把 null 当 false 处理，用户一按「对答案」就先吃一个红叉。
 */
export function QuestionCard({
  question,
  index,
  total,
  context = 'quiz',
  onAnswer,
  onNext,
  autoFocus = true,
}: {
  question: Question;
  index: number;
  total: number;
  context?: string;
  /** selfCorrect 只有解答 / 证明题会传，服务端也只认这两种题型 */
  onAnswer: (answer: string, opts?: { selfCorrect?: boolean }) => Promise<AnswerResult>;
  onNext: () => void;
  autoFocus?: boolean;
}) {
  const type = question.type;
  const isMulti = type === 'multi';
  const isJudge = type === 'judge';
  const isSelfGraded = type === 'solve' || type === 'proof';
  const isPick = type === 'choice' || isMulti || isJudge;

  const [picked, setPicked] = useState('');
  const [multiPicked, setMultiPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  // 换题时重置
  useEffect(() => {
    setPicked('');
    setMultiPicked([]);
    setText('');
    setResult(null);
    setBusy(false);
    if (autoFocus && (type === 'blank' || isSelfGraded)) {
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [question.id, autoFocus, type, isSelfGraded]);

  const answer = type === 'choice' ? picked
    : isMulti ? multiPicked.join('')
      : text;

  /** 还停在「亮答案」这一步 —— 用户看到参考答案但还没自评 */
  const awaitingSelfGrade = !!result?.selfGrade;
  const judged = !!result && !awaitingSelfGrade;

  const canSubmit = !result && !busy
    && (type === 'choice' ? !!picked
      : isMulti ? multiPicked.length >= 2
        : isJudge ? !!text
          : text.trim().length > 0);

  const submit = async (val?: string, opts?: { selfCorrect?: boolean }) => {
    const a = (val ?? answer).trim();
    if (!a || busy) return;
    /* 判过就不许再提交。但「亮答案」那一步之后要放行 ——
     * 自评本身就是第二次提交。 */
    if (result && !awaitingSelfGrade) return;
    setBusy(true);
    try {
      const r = await onAnswer(a, opts);
      setResult(r);
      /* correct === null 是「还没判」，别出声 —— 出错了音效就变成了误导 */
      if (r.correct === true) sfxCorrect(r.combo?.combo ?? 1);
      else if (r.correct === false) sfxWrong();
      setTimeout(() => nextRef.current?.focus(), 80);
    } catch {
      /* 保持原状，让用户能重试 */
    } finally {
      setBusy(false);
    }
  };

  const toggleMulti = (k: string) => {
    if (result) return;
    setMultiPicked((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
  };

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        /* 自评阶段 Enter 什么都不做 —— 这一步必须是有意识的选择，
         * 顺手按一下 Enter 就替自己打了分，那是把自评变成噪声。 */
        if (awaitingSelfGrade) return;
        if (judged) { e.preventDefault(); onNext(); return; }
        /* 多选和解答题的作答是多字符的，Enter 只提交、不补全 */
        if (canSubmit && !e.shiftKey) { e.preventDefault(); submit(); }
        return;
      }

      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;

      if (type === 'choice' && !result && question.options && n <= question.options.length) {
        const opt = question.options[n - 1];
        setPicked(opt.k);
        // 单选按数字键直接提交，刷题更快
        setTimeout(() => submit(opt.k), 60);
        return;
      }
      if (isMulti && !result && question.options && n <= question.options.length) {
        toggleMulti(question.options[n - 1].k);
        return;
      }
      if (isJudge && !result) {
        if (n === 1) { setText('T'); setTimeout(() => submit('T'), 60); }
        if (n === 2) { setText('F'); setTimeout(() => submit('F'), 60); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, awaitingSelfGrade, judged, canSubmit, answer, question, onNext, multiPicked]);

  const diff = DIFFICULTY[question.difficulty] || DIFFICULTY[2];

  return (
    <Panel
      className={cn(
        'relative overflow-hidden p-5',
        result?.correct === true && 'feedback-right border-emerald/30',
        result?.correct === false && 'feedback-wrong border-rose/30',
      )}
    >
      {/* 题头 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-fg-mute tabular">
          {index + 1} / {total}
        </span>
        <span className={cn('rounded-md border px-1.5 py-0.5 text-[11px]', diff.cls)}>{diff.label}</span>
        {question.sourceType && (
          <Badge tone="neutral">
            {question.sourceType}
            {question.sourceYear ? ` · ${question.sourceYear}` : ''}
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-fg-faint">{question.typeLabel}</span>
      </div>

      {/* 题干 */}
      <div className="text-[15px] leading-[1.9] text-fg">
        <RichText text={question.stem} bareLatex />
      </div>

      {/* 作答区 */}
      <div className="mt-5">
        {type === 'choice' && question.options && (
          <div className="space-y-2">
            {question.options.map((o, i) => {
              const isPicked = picked === o.k;
              const isAnswer = result && String(result.answer).toUpperCase() === o.k.toUpperCase();
              const isWrongPick = result && isPicked && !result.correct;
              return (
                <OptionButton
                  key={o.k}
                  k={o.k}
                  hotkey={i + 1}
                  disabled={!!result}
                  state={isAnswer ? 'right' : isWrongPick ? 'wrong' : result ? 'dim' : 'idle'}
                  onClick={() => { setPicked(o.k); submit(o.k); }}
                >
                  <InlineMath text={o.t} />
                </OptionButton>
              );
            })}
          </div>
        )}

        {isMulti && question.options && (
          <div className="space-y-2">
            <p className="mb-1 text-[11.5px] text-fg-mute">
              多选题 —— 全部选对才得分，少选或多选都算错。按数字键切换，Enter 提交。
            </p>
            {question.options.map((o, i) => {
              const isPicked = multiPicked.includes(o.k);
              /* 多选题的对错要按**集合**看：选中的里有没有多余的、该选的有没有漏。
               * 只高亮「答案里有且我选了」会漏掉「我多选了 C」这个关键信息。 */
              const inAnswer = !!result && String(result.answer).toUpperCase().includes(o.k.toUpperCase());
              const state = !result
                ? (isPicked ? 'picked' : 'idle')
                : inAnswer && isPicked ? 'right'
                  : inAnswer && !isPicked ? 'missed'
                    : !inAnswer && isPicked ? 'wrong' : 'dim';
              return (
                <OptionButton
                  key={o.k}
                  k={o.k}
                  hotkey={i + 1}
                  disabled={!!result}
                  state={state}
                  onClick={() => toggleMulti(o.k)}
                >
                  <InlineMath text={o.t} />
                </OptionButton>
              );
            })}
            {!result && (
              <div className="flex items-center gap-2.5 pt-1">
                <Button onClick={() => submit()} disabled={!canSubmit} loading={busy}>
                  提交{multiPicked.length > 0 && `（已选 ${multiPicked.length} 项）`}
                </Button>
              </div>
            )}
          </div>
        )}

        {isJudge && (
          <div className="space-y-2.5">
            <p className="text-[11.5px] text-fg-mute">
              判断题 —— 判断上面这句话对不对。按 1 / 2 也能作答。
            </p>
            <div className="flex gap-2.5">
              {[
                { k: 'T', label: '正确', hotkey: 1 },
                { k: 'F', label: '错误', hotkey: 2 },
              ].map((o) => {
                const isPicked = text === o.k;
                const isAnswer = judged && String(result!.answer).toUpperCase() === o.k;
                const isWrongPick = judged && isPicked && !result!.correct;
                return (
                  <button
                    key={o.k}
                    disabled={!!result}
                    onClick={() => { setText(o.k); submit(o.k); }}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-2.5 rounded-xl border py-3 text-[14px] font-medium transition-all duration-200',
                      'disabled:cursor-default',
                      !result && 'border-hairline bg-veil/3 text-fg-soft hover:border-cyan/35 hover:bg-veil/6',
                      isAnswer && 'border-emerald/45 bg-emerald/10 text-emerald-200',
                      isWrongPick && 'border-rose/45 bg-rose/10 text-rose-200',
                      result && !isAnswer && !isWrongPick && 'border-hairline bg-veil/2 text-fg-mute opacity-55',
                    )}
                  >
                    {o.k === 'T' ? <Check size={16} /> : <X size={16} />}
                    {o.label}
                    <kbd className="rounded border border-veil/10 px-1.5 py-0.5 text-[10px] text-fg-faint">{o.hotkey}</kbd>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {type === 'blank' && (
          <div className="flex gap-2.5">
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              value={text}
              disabled={!!result}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入你的答案，支持 1/2、0.5、pi 这类写法"
              className={cn(
                'h-11 flex-1 rounded-xl border bg-veil/4 px-3.5 font-mono text-[14px] text-fg outline-none transition-all',
                'placeholder:font-sans placeholder:text-fg-faint',
                'focus:border-cyan/50 focus:halo-cyan',
                result?.correct === false ? 'border-rose/45' : result?.correct ? 'border-emerald/45' : 'border-hairline',
              )}
            />
            {!result && (
              <Button onClick={() => submit()} disabled={!canSubmit} loading={busy}>
                提交
              </Button>
            )}
          </div>
        )}

        {isSelfGraded && (
          <div className="space-y-2.5">
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={text}
              /* 自评阶段要能继续编辑 —— 看完参考答案想补一句再打分是常态 */
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={
                type === 'proof'
                  ? '写下你的证明过程。可以用「因为 / 所以 / 由…可得」分段，一行一步。'
                  : '写下你的解答过程，一行一步。公式用 $...$ 包起来。'
              }
              className={cn(
                'w-full resize-y rounded-xl border bg-veil/4 px-3.5 py-3 font-mono text-[13.5px] leading-[1.8] text-fg outline-none transition-all',
                'placeholder:font-sans placeholder:text-fg-faint',
                'focus:border-cyan/50 focus:halo-cyan',
                judged ? (result!.correct ? 'border-emerald/45' : 'border-rose/45') : 'border-hairline',
              )}
            />
            {!result && (
              <div className="flex flex-wrap items-center gap-2.5">
                <Button onClick={() => submit()} disabled={!canSubmit} loading={busy}>
                  <Eye size={14} /> 提交并对答案
                </Button>
                <span className="text-[11.5px] text-fg-faint">
                  {type === 'proof' ? '证明题' : '解答题'}没有唯一写法，机器判不了 ——
                  先自己写完，再对着参考答案给自己打分
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 反馈 */}
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {awaitingSelfGrade ? (
              <SelfGradeReview
                result={result}
                onGrade={(ok) => submit(text, { selfCorrect: ok })}
                busy={busy}
              />
            ) : (
              <>
                <div
                  className={cn(
                    'mt-4 rounded-xl border px-4 py-3.5',
                    result.correct ? 'border-emerald/28 bg-emerald/8' : 'border-rose/28 bg-rose/8',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('flex items-center gap-1.5 text-[13px] font-semibold', result.correct ? 'text-emerald-200' : 'text-rose-200')}>
                      {result.correct ? <Check size={14} /> : <X size={14} />}
                      {result.correct ? '答对了' : '答错了'}
                    </span>
                    {!result.correct && (
                      <span className="text-[12.5px] text-fg-soft">
                        正确答案：<span className="font-mono text-fg"><InlineMath text={result.answer} /></span>
                      </span>
                    )}
                    {!!result.xp?.gained && result.xp.gained > 0 && (
                      <Badge tone="violet" className="ml-auto">
                        <Zap size={10} /> +{result.xp.gained} XP
                        {result.xpNote ? ` · ${result.xpNote}` : ''}
                      </Badge>
                    )}
                  </div>

                  {result.analysis && (
                    <div className="mt-3 border-t border-veil/8 pt-3">
                      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-fg-mute">
                        <Lightbulb size={12} /> 解析
                      </div>
                      <div className="text-[13px] leading-[1.85] text-fg-soft">
                        <RichText text={result.analysis} bareLatex />
                      </div>
                    </div>
                  )}

                  {!result.correct && result.mastery && (
                    <div className="mt-2.5 text-[11.5px] text-fg-mute">
                      该考点掌握度：{result.mastery.label} · 正确率 {Math.round(result.mastery.accuracy * 100)}%
                      {result.mastery.attempts < 3 && ' · 至少答 3 次才能评上熟练'}
                    </div>
                  )}
                </div>

                <div className="mt-3.5 flex justify-end">
                  <Button ref={nextRef} onClick={onNext} variant={index + 1 >= total ? 'success' : 'primary'}>
                    {index + 1 >= total ? '完成' : '下一题'}
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}

/* ---------- 选项按钮（单选 / 多选共用）----------
 *
 * 状态比单选多两个，都是多选特有的：
 *   missed —— 答案里有、我没选（漏选）
 *   picked —— 已选但还没提交
 * 少了它们，「我漏了 C」和「我多选了 D」在界面上长得一样，
 * 而这两种错的补救办法完全不同。
 */
type OptionState = 'idle' | 'picked' | 'right' | 'wrong' | 'missed' | 'dim';

function OptionButton({
  k, hotkey, state, disabled, onClick, children,
}: {
  k: string; hotkey: number; state: OptionState; disabled: boolean;
  onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200',
        'disabled:cursor-default',
        state === 'idle' && 'border-hairline bg-veil/3 hover:border-cyan/35 hover:bg-veil/6',
        state === 'picked' && 'border-cyan/45 bg-cyan/10',
        state === 'right' && 'border-emerald/45 bg-emerald/10',
        state === 'wrong' && 'border-rose/45 bg-rose/10',
        state === 'missed' && 'border-amber/45 bg-amber/10',
        state === 'dim' && 'border-hairline bg-veil/2 opacity-55',
      )}
    >
      <span
        className={cn(
          'grid h-6 w-6 shrink-0 place-items-center rounded-lg border text-[11.5px] font-semibold transition-colors',
          state === 'right' ? 'border-emerald/50 bg-emerald/20 text-emerald-200'
            : state === 'wrong' ? 'border-rose/50 bg-rose/20 text-rose-200'
              : state === 'missed' ? 'border-amber/50 bg-amber/20 text-amber-200'
                : state === 'picked' ? 'border-cyan/50 bg-cyan/20 text-cyan-100'
                  : 'border-veil/10 bg-veil/5 text-fg-mute group-hover:border-cyan/30 group-hover:text-fg-soft',
        )}
      >
        {state === 'right' ? <Check size={12} /> : state === 'wrong' ? <X size={12} /> : k}
      </span>
      <span className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-fg-soft">{children}</span>
      {state === 'missed' && <span className="shrink-0 text-[10.5px] text-amber-200/90">漏选</span>}
      <kbd className="hidden shrink-0 rounded border border-veil/8 px-1.5 py-0.5 text-[10px] text-fg-faint group-hover:block">
        {hotkey}
      </kbd>
    </button>
  );
}

/* ---------- 解答题 / 证明题的自评面板 ----------
 *
 * 摆在这里的东西只有三样，顺序是有讲究的：
 *   1. 我的解答（让用户先看见自己写了什么，再去看标准答案 —— 反过来的话
 *      人的记忆会被答案覆盖，自评就变成了「照着答案说自己对」）
 *   2. 参考答案 + 评分点（分步给分，逐条标分值）
 *   3. 两个按钮
 */
function SelfGradeReview({
  result, onGrade, busy,
}: {
  result: AnswerResult;
  onGrade: (ok: boolean) => void;
  busy: boolean;
}) {
  const steps = result.steps || [];
  const totalPts = useMemo(() => steps.reduce((a, s) => a + (s.pts || 0), 0), [steps]);

  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-xl border border-cyan/25 bg-cyan/6 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium text-cyan-100">
          <Eye size={12} /> 对答案 —— 这一步不记账，看完自己给自己打分
        </div>
        <div className="mb-3">
          <div className="mb-1 text-[11px] text-fg-mute">我的解答</div>
          <div className="whitespace-pre-wrap rounded-lg border border-veil/8 bg-veil/3 px-3 py-2 font-mono text-[12.5px] leading-[1.8] text-fg-soft">
            {result.myAnswer || '（空）'}
          </div>
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-mute">
            <span>参考答案</span>
            {totalPts > 0 && (
              <span className="flex items-center gap-1 text-amber-200/90">
                <ListChecks size={11} /> 共 {totalPts} 分
              </span>
            )}
          </div>
          <div className="rounded-lg border border-emerald/25 bg-emerald/6 px-3 py-2.5 text-[13px] leading-[1.85] text-fg-soft">
            <RichText text={result.answer} bareLatex />
          </div>
        </div>

        {steps.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[11px] text-fg-mute">评分点（逐条对照，给自己算个分）</div>
            <ol className="space-y-1.5">
              {steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2.5 rounded-lg border border-veil/8 bg-veil/3 px-3 py-2">
                  <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md border border-veil/10 bg-veil/6 text-[10.5px] text-fg-mute">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-soft">
                    <RichText text={s.t} bareLatex inline />
                  </span>
                  {s.pts > 0 && (
                    <span className="shrink-0 text-[11px] tabular text-amber-200/90">{s.pts} 分</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {result.analysis && (
          <div className="mt-3 border-t border-veil/8 pt-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-fg-mute">
              <Lightbulb size={11} /> 思路要点
            </div>
            <div className="text-[12.5px] leading-[1.85] text-fg-soft">
              <RichText text={result.analysis} bareLatex />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="success" onClick={() => onGrade(true)} loading={busy}>
          <Check size={14} /> 我做对了
        </Button>
        <Button variant="danger" onClick={() => onGrade(false)} loading={busy}>
          <X size={14} /> 我做错了
        </Button>
        <span className="text-[11.5px] text-fg-faint">
          按「做错了」会进错题本，之后还能重练
        </span>
      </div>
    </div>
  );
}

/* 空队列提示 */
export function QuizEmpty({ title, desc, action }: { title: string; desc: string; action?: React.ReactNode }) {
  return (
    <Panel className="flex flex-col items-center px-6 py-14 text-center">
      <div className="float mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-veil/8 bg-veil/4 text-emerald">
        <Check size={24} />
      </div>
      <h3 className="text-[15px] font-medium text-fg-soft">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-mute">{desc}</p>
      {action && <div className="mt-5">{action}</div>}
    </Panel>
  );
}

export { RotateCcw };
