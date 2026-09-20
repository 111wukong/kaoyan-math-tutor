/* 路由表
 *
 * 单独放一个文件，是因为它要同时被两处用：
 *   · AppShell 渲染页面（KeepAlivePages 按这张表保活）
 *   · 顶栏面包屑反查当前在哪一层
 * 两处各写一份迟早会漂移 —— 加了个页面，面包屑里没有它，
 * 顶栏就退回显示「研数」，而且没人会注意到。
 *
 * 元素写在这里而不是在使用处 new：React 元素的身份要稳定，
 * 每次渲染都新建一个 <Dashboard /> 会让保活的页面被当成新节点重建，
 * 状态照样丢。模块级常量保证它整个会话里是同一个对象。
 */
import type { PageDef } from '@/components/layout/KeepAlivePages';

import Dashboard from '@/pages/Dashboard';
import Knowledge from '@/pages/Knowledge';
import KnowledgeDetail from '@/pages/KnowledgeDetail';
import Quiz from '@/pages/Quiz';
import Review from '@/pages/Review';
import Mistakes from '@/pages/Mistakes';
import Questions from '@/pages/Questions';
import Stats from '@/pages/Stats';
import Lab from '@/pages/Lab';
import Blitz from '@/pages/Blitz';
import Deck from '@/pages/Deck';
import Chat from '@/pages/Chat';
import Classroom from '@/pages/Classroom';
import Achievements from '@/pages/Achievements';
import Settings from '@/pages/Settings';
import Admin from '@/pages/Admin';

export const APP_PAGES: PageDef[] = [
  { path: '/', node: <Dashboard /> },
  { path: '/learn', node: <Knowledge /> },
  { path: '/learn/:kid', node: <KnowledgeDetail /> },
  { path: '/quiz', node: <Quiz /> },
  { path: '/review', node: <Review /> },
  { path: '/mistakes', node: <Mistakes /> },
  { path: '/questions', node: <Questions /> },
  { path: '/stats', node: <Stats /> },
  { path: '/lab', node: <Lab /> },
  { path: '/blitz', node: <Blitz /> },
  { path: '/deck', node: <Deck /> },
  { path: '/chat', node: <Chat /> },
  { path: '/classroom', node: <Classroom /> },
  { path: '/achievements', node: <Achievements /> },
  { path: '/settings', node: <Settings /> },
  /* 管理台。这里不做角色判断 —— 页面自己会检查并跳回首页。
   * 真正的门在服务端：/api/admin/* 每条路由都挂 requireAdmin，
   * 非管理员即便把这一行删掉也拿不到数据。 */
  { path: '/admin', node: <Admin /> },
];
