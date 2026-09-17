import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { CyberGrid } from '@/components/fx/CyberGrid';
import { Starfield } from '@/components/fx/Starfield';
import { InlineMath } from '@/components/ui/Math';
import { Brain, CalendarCheck, LineChart, Sparkles } from 'lucide-react';

/* 认证页外壳：左侧品牌叙事 + 右侧表单
 *
 * 左侧不是装饰 —— 首次访问的人需要在这里搞清楚"这是干什么的"，
 * 否则注册页就是一个不知道为什么要填的表格。
 */
export function AuthLayout({ children, mode }: { children: ReactNode; mode: 'login' | 'register' }) {
  return (
    <div className="relative grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* 认证页内容少、留白大，是唯一可以"放肆"的地方 —— 亮度给到 0.72。
       * 仪表盘那边同样这个效果但要压到 0.62，因为那边满屏都是要读的字。 */}
      <CyberGrid intensity={0.72} />
      <Starfield density={0.00013} />

      {/* 左：品牌 */}
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-hairline px-10 py-12 lg:flex xl:px-16">
        {/* 文案区的暗色渐隐。为什么必须有：地平线光带是整张图最亮的一条，
         * 而左侧文案正好横跨它的高度 —— 白字压在浅蓝光晕上，对比度直接掉一半。
         * 这层从左边暗到右边透明，把光带"推"到右半屏去，
         * 既保住了效果，也保住了文字。 */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-[62%] bg-gradient-to-r from-ink-1000/85 via-ink-1000/50 to-transparent" />

        <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-cyan/12 blur-[120px]" />
        <div className="pointer-events-none absolute -bottom-20 right-0 h-80 w-80 rounded-full bg-violet/12 blur-[110px]" />

        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative flex items-center gap-3"
        >
          <div className="relative grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-cyan/30 to-violet/24 ring-1 ring-white/12">
            <span className="text-[21px] font-semibold">
              <span className="text-aurora">∫</span>
            </span>
          </div>
          <div>
            <div className="text-[17px] font-semibold tracking-tight text-fg">研数</div>
            <div className="text-[11.5px] text-fg-mute">考研数学 · AI 自学系统</div>
          </div>
        </motion.div>

        <div className="relative max-w-md">
          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.08 }}
            className="text-[34px] font-semibold leading-[1.28] tracking-tight text-fg xl:text-[40px]"
          >
            每天 30 分钟，
            <br />
            <span className="text-spectrum">数学不掉队。</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.16 }}
            className="mt-4 text-[14px] leading-[1.85] text-fg-soft"
          >
            它不是聊天框。它是一个调度器 —— 每天决定你今天该复习什么、
            学什么、练什么，然后按遗忘曲线把知识推回你面前。
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.24 }}
            className="mt-8 space-y-3.5"
          >
            {[
              { icon: Brain, title: '主动回忆，而不是重读', desc: '苏格拉底式追问，逼你自己检索出答案' },
              { icon: CalendarCheck, title: 'SM-2 间隔重复', desc: '在你快忘掉的那一刻，把知识推回来' },
              { icon: LineChart, title: '每个考点都有掌握概率', desc: '知道你到底哪不会，而不是凭感觉' },
            ].map((f, i) => (
              <div key={f.title} className="flex items-start gap-3">
                <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/8 bg-white/4 text-cyan">
                  <f.icon size={15} />
                </div>
                <div>
                  <div className="text-[13.5px] font-medium text-fg">{f.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-mute">{f.desc}</div>
                </div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* 漂浮公式：让"数学"这件事在第一眼就被看见 */}
        <div className="relative h-16">
          {[
            { tex: '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1', x: '2%', d: 0 },
            { tex: '\\int_a^b f(x)\\,dx', x: '30%', d: 0.5 },
            { tex: '\\sum_{n=1}^{\\infty}\\frac{1}{n^2}', x: '58%', d: 1.1 },
            { tex: "f'(x_0)", x: '82%', d: 1.6 },
          ].map((f, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5, y: [0, -7, 0] }}
              transition={{
                opacity: { duration: 0.8, delay: 0.5 + i * 0.12 },
                y: { duration: 5 + i, repeat: Infinity, ease: 'easeInOut', delay: f.d },
              }}
              className="absolute text-[13px] text-fg-mute"
              style={{ left: f.x }}
            >
              <InlineMath text={`$${f.tex}$`} />
            </motion.div>
          ))}
        </div>
      </section>

      {/* 右：表单 */}
      <section className="relative flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-64 -translate-x-1/2 rounded-full bg-blue/10 blur-[100px] lg:hidden" />
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[400px]"
        >
          {/* 移动端顶部品牌 */}
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan/28 to-violet/22 ring-1 ring-white/12">
              <span className="text-[17px] font-semibold">
                <span className="text-aurora">∫</span>
              </span>
            </div>
            <div>
              <div className="text-[14.5px] font-semibold text-fg">研数</div>
              <div className="text-[10.5px] text-fg-faint">考研数学 · AI 自学系统</div>
            </div>
          </div>

          <div className="glass-strong hairline-top relative rounded-2xl p-6 sm:p-7">
            <div className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-b from-cyan/8 to-transparent opacity-60" />
            <div className="relative">{children}</div>
          </div>

          <p className="mt-5 flex items-center justify-center gap-1.5 text-[11.5px] text-fg-faint">
            <Sparkles size={12} />
            {mode === 'login' ? '数据存在你自己的数据库里，不上传任何第三方' : '注册即开始，不需要邮箱验证'}
          </p>
        </motion.div>
      </section>
    </div>
  );
}
