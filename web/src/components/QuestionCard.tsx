import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Lightbulb, RotateCcw, X, Zap } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui/Primitives';
import { InlineMath, RichText } from '@/components/ui/Math';
import { cn, DIFFICULTY } from '@/lib/utils';
import { sfxCorrect, sfxWrong } from '@/lib/sfx';
import type { AnswerResult, Question } from '@/lib/api';

/* 单题作答卡
 * 交互链路：作答 → 判分 → 反馈（对错 + 解析 + XP）→ 下一题
 * 键盘：1-4 选选项，Enter 提交，Enter 再按一次进入下一题 —— 刷题时不该离开键盘。
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
  onAnswer: (answer: string) => Promise<AnswerResult>;
  onNext: () => void;
  autoFocus?: boolean;
}) {
  const [picked, setPicked] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  // 换题时重置
  useEffect(() => {
    setPicked('');
    setText('');
    setResult(null);
    setBusy(false);
    if (autoFocus && question.type === 'blank') {
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [question.id, autoFocus, question.type]);

  const answer = question.type === 'choice' ? picked : text;
  const canSubmit = !result && !busy && answer.trim().length > 0;

  const submit = async (val?: string) => {
    const a = (val ?? answer).trim();
    if (!a || busy || result) return;
    setBusy(true);
    try {
      const r = await onAnswer(a);
      setResult(r);
      if (r.correct) sfxCorrect(r.combo?.combo ?? 1); else sfxWrong();
      setTimeout(() => nextRef.current?.focus(), 80);
    } catch {
      setBusy(false);
    }
  };

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (result) { e.preventDefault(); onNext(); return; }
        if (canSubmit) { e.preventDefault(); submit(); }
        return;
      }
      if (question.type === 'choice' && !result && question.options) {
        const n = Number(e.key);
        if (n >= 1 && n <= question.options.length) {
          const opt = question.options[n - 1];
          setPicked(opt.k);
          // 选择题按数字键直接提交，刷题更快
          setTimeout(() => submit(opt.k), 60);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, canSubmit, answer, question, onNext]);

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
        <span className="ml-auto text-[11px] text-fg-faint">
          {question.type === 'choice' ? '选择' : '填空'}
        </span>
      </div>

      {/* 题干 */}
      <div className="text-[15px] leading-[1.9] text-fg">
        <RichText text={question.stem} bareLatex />
      </div>

      {/* 作答区 */}
      <div className="mt-5">
        {question.type === 'choice' && question.options ? (
          <div className="space-y-2">
            {question.options.map((o, i) => {
              const isPicked = picked === o.k;
              const isAnswer = result && String(result.answer).toUpperCase() === o.k.toUpperCase();
              const isWrongPick = result && isPicked && !result.correct;
              return (
                <button
                  key={o.k}
                  disabled={!!result}
                  onClick={() => { setPicked(o.k); submit(o.k); }}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200',
                    'disabled:cursor-default',
                    !result && 'border-hairline bg-white/3 hover:border-cyan/35 hover:bg-white/6',
                    isAnswer && 'border-emerald/45 bg-emerald/10',
                    isWrongPick && 'border-rose/45 bg-rose/10',
                    result && !isAnswer && !isWrongPick && 'border-hairline bg-white/2 opacity-55',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-lg border text-[11.5px] font-semibold transition-colors',
                      isAnswer ? 'border-emerald/50 bg-emerald/20 text-emerald-200'
                        : isWrongPick ? 'border-rose/50 bg-rose/20 text-rose-200'
                          : 'border-white/10 bg-white/5 text-fg-mute group-hover:border-cyan/30 group-hover:text-fg-soft',
                    )}
                  >
                    {isAnswer ? <Check size={12} /> : isWrongPick ? <X size={12} /> : o.k}
                  </span>
                  <span className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-fg-soft">
                    <InlineMath text={o.t} />
                  </span>
                  <kbd className="hidden shrink-0 rounded border border-white/8 px-1.5 py-0.5 text-[10px] text-fg-faint group-hover:block">
                    {i + 1}
                  </kbd>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex gap-2.5">
            <input
              ref={inputRef}
              value={text}
              disabled={!!result}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入你的答案，支持 1/2、0.5、pi 这类写法"
              className={cn(
                'h-11 flex-1 rounded-xl border bg-white/4 px-3.5 font-mono text-[14px] text-fg outline-none transition-all',
                'placeholder:font-sans placeholder:text-fg-faint',
                'focus:border-cyan/50 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.09)]',
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
                {result.xp?.gained > 0 && (
                  <Badge tone="violet" className="ml-auto">
                    <Zap size={10} /> +{result.xp.gained} XP
                    {result.xpNote ? ` · ${result.xpNote}` : ''}
                  </Badge>
                )}
              </div>

              {result.analysis && (
                <div className="mt-3 border-t border-white/8 pt-3">
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
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}

/* 空队列提示 */
export function QuizEmpty({ title, desc, action }: { title: string; desc: string; action?: React.ReactNode }) {
  return (
    <Panel className="flex flex-col items-center px-6 py-14 text-center">
      <div className="float mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-white/8 bg-white/4 text-emerald">
        <Check size={24} />
      </div>
      <h3 className="text-[15px] font-medium text-fg-soft">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-mute">{desc}</p>
      {action && <div className="mt-5">{action}</div>}
    </Panel>
  );
}

export { RotateCcw };
