/* 站内链接的统一入口 —— 一律在新标签页打开
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────
 * 需求是「从一个网页进入另一个网页，浏览器要新开一个，上一个网页留着」。
 * 直接在每个 <Link> 上手写 target="_blank" 也能实现，但那是 15 个散落的
 * 魔法字符串：将来想改成「只有侧栏新开」或者「都不新开」，得挨个找。
 * 收在一个地方，行为就只有一份定义。
 *
 * ── 为什么 target="_blank" 就够了，不需要自己调 window.open ──────
 * react-router 的 Link 在 click 处理器里是这么判断的：
 *
 *   if (event.button === 0 && (!target || target === "_self") && !isModifiedEvent(event))
 *     event.preventDefault()   // ← 只有这一支才接管跳转
 *
 * 也就是说 target 一旦不是 _self，它**主动放弃**接管，把点击还给浏览器。
 * 浏览器按原生 <a target="_blank"> 处理 —— 新标签、原页面不动。
 * 自己写 window.open 反而会丢掉中键点击、右键「在新标签页打开」、
 * 以及「按住 Cmd 点」这些原生行为。
 *
 * ── rel 为什么不能省 ─────────────────────────────────────────────
 * 没有 rel="noopener" 时，新页面能通过 window.opener 反向操作原页面
 * （把原页面导航到钓鱼站是经典手法）。noopener 让 window.opener 变成 null。
 * noreferrer 顺带不发 Referer —— 这是自己家的站内跳转，少暴露一点是一点。
 *
 * ── 怎么改回单标签页 ─────────────────────────────────────────────
 * 把下面 DEFAULT_TARGET 改成 '_self' 即可，全站一次性生效。
 * 注意别只改一处：AppLink 和 AppNavLink 共用这个常量，就是为了避免那种改一半。
 */
import type { ComponentProps } from 'react';
import { Link as RouterLink, NavLink as RouterNavLink } from 'react-router-dom';

/** 想恢复成「当前标签页内跳转」，把这里改成 '_self' */
const DEFAULT_TARGET: ComponentProps<typeof RouterLink>['target'] = '_blank';
const DEFAULT_REL = 'noopener noreferrer';

/** 站内普通链接。用法与 react-router 的 <Link> 完全一致。 */
export function AppLink({ target, rel, ...rest }: ComponentProps<typeof RouterLink>) {
  return <RouterLink target={target ?? DEFAULT_TARGET} rel={rel ?? DEFAULT_REL} {...rest} />;
}

/** 站内导航链接（需要 isActive 时用它）。用法与 <NavLink> 一致，含 render-prop 形式。 */
export function AppNavLink({ target, rel, ...rest }: ComponentProps<typeof RouterNavLink>) {
  return <RouterNavLink target={target ?? DEFAULT_TARGET} rel={rel ?? DEFAULT_REL} {...rest} />;
}
