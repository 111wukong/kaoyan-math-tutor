import { Component, type ErrorInfo, type ReactNode } from 'react';

/* ============================================================
   全局错误边界
   ============================================================
   这个项目历史上被「整站白屏」坑过一次：BootScreen 在 <Router> 外面
   调了 useLocation，React 直接抛错并卸载整棵树，用户看到的就是一片空白，
   连「出错了」三个字都没有。当时是靠浏览器冒烟测试里那条
   「首屏不能白屏」的断言抓到的 —— 但那条断言守的是**开发阶段**，
   线上用户撞到同样的事时，没有任何东西能给他。

   React 的规则：渲染期抛出的异常会卸载整棵树，除非有错误边界接住。
   所以在最外层包一个，把「白屏」换成「出错了 + 两个能点的按钮」。

   ★ 这里**不能用任何 react-router 的 hook**（useLocation / useNavigate）——
     它就是用来兜住「Router 自己挂了」这种事的，用 Router 的东西兜 Router
     会连兜底页一起白屏。所以「回首页」用 location.assign。
     同理不依赖主题 store：主题挂掉的时候这个页面也得能看。
   ============================================================ */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  showDetail: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, showDetail: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    /* 留在 console 里。没有接外部错误上报，日志是唯一的现场 ——
     * 用户截图反馈时，这一条就是全部线索。 */
    console.error('[研数] 渲染期异常，已被错误边界接住：', error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private goHome = () => {
    window.location.assign('/');
  };

  render() {
    const { error, info, showDetail } = this.state;
    if (!error) return this.props.children;

    /* 只展示第一段堆栈：完整的 componentStack 又长又吓人，
     * 用户需要的是一个能复述的短句，不是一个 React 内部调用链。 */
    const brief = (info?.componentStack || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join('\n');

    return (
      <div className="grid min-h-dvh place-items-center px-5 py-10">
        <div className="w-full max-w-lg rounded-2xl border border-veil/12 bg-veil/5 p-6 sm:p-7">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint">
            页面出错了
          </div>
          <h1 className="mt-2 text-[19px] font-semibold leading-snug text-fg">
            这一页没能渲染出来
          </h1>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-fg-mute">
            你的学习数据都在服务端，没有丢。先刷新试试；如果还不行，
            回首页换个入口，这一页的问题不会影响别的页面。
          </p>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              onClick={this.reload}
              className="h-10 rounded-xl bg-gradient-to-r from-cyan to-blue px-4 text-sm font-semibold text-on-accent"
            >
              重新加载
            </button>
            <button
              onClick={this.goHome}
              className="h-10 rounded-xl border border-hairline-strong bg-veil/4 px-4 text-sm text-fg transition-colors hover:bg-veil/8"
            >
              回首页
            </button>
            <button
              onClick={() => this.setState((s) => ({ showDetail: !s.showDetail }))}
              className="h-10 rounded-xl px-3 text-sm text-fg-soft transition-colors hover:bg-veil/6"
            >
              {showDetail ? '收起详情' : '看详情'}
            </button>
          </div>

          {showDetail && (
            <div className="mt-4 rounded-xl border border-hairline bg-ink-900/80 p-3.5">
              <div className="font-mono text-[12px] leading-relaxed text-rose">
                {error.message || String(error)}
              </div>
              {brief && (
                <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-faint">
                  {brief}
                </pre>
              )}
              <div className="mt-2.5 text-[11.5px] text-fg-faint">
                截图这一段发给维护者，比描述「它坏了」有用得多。
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
}

/* ============================================================
   异步异常的兜底
   ============================================================
   React 的错误边界**只接渲染期**的异常。Promise 里 reject 掉的
   （SSE 流、AI 请求、任何 fetch 链）它一个都接不住，而且默认是静默的 ——
   浏览器控制台里有一条，页面上什么都没有，用户只会觉得「点了没反应」。

   这里把它们捞出来，走 toast 提示一次。toast 依赖 zustand store，
   不是 React 树的一部分，所以应用主体还活着的时候一定可用。
   ============================================================ */
export function installGlobalErrorHandlers(pushToast: (t: {
  kind: 'error'; title: string; desc?: string; ttl?: number;
}) => void) {
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    /* AbortError 是正常的取消（切页面、关弹窗都会触发），不是故障。 */
    if (reason?.name === 'AbortError') return;

    const msg = reason?.message || String(reason || '未知错误');
    console.error('[研数] 未处理的异步异常：', reason);
    pushToast({
      kind: 'error',
      title: '有个请求没成功',
      desc: msg.slice(0, 120),
    });
  });

  /* 同步的 window.onerror：模块加载失败、第三方脚本抛错走这条。
   * 渲染期的已经被 ErrorBoundary 接住了，这里只兜剩下的。 */
  window.addEventListener('error', (e) => {
    if (e.error?.__handledByBoundary) return;
    console.error('[研数] 全局错误：', e.error || e.message);
  });
}
