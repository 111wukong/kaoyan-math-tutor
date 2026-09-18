import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '@/stores/auth';
import { AppShell } from '@/components/layout/AppShell';

import Login from '@/pages/Login';
import Register from '@/pages/Register';
import Dashboard from '@/pages/Dashboard';
import Knowledge from '@/pages/Knowledge';
import KnowledgeDetail from '@/pages/KnowledgeDetail';
import Quiz from '@/pages/Quiz';
import Review from '@/pages/Review';
import Mistakes from '@/pages/Mistakes';
import Stats from '@/pages/Stats';
import Lab from '@/pages/Lab';
import Blitz from '@/pages/Blitz';
import Deck from '@/pages/Deck';
import Chat from '@/pages/Chat';
import Classroom from '@/pages/Classroom';
import Achievements from '@/pages/Achievements';
import Settings from '@/pages/Settings';
import Admin from '@/pages/Admin';

export default function App() {
  const { user, ready, refresh } = useAuth();

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 会话探测完成前什么都不渲染 —— 否则已登录用户会先闪一下登录页
  if (!ready) return <BootScreen />;

  return (
    <BrowserRouter>
      <AnimatePresence mode="wait">
        {user ? (
          <motion.div
            key="app"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35 }}
          >
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/learn" element={<Knowledge />} />
                <Route path="/learn/:kid" element={<KnowledgeDetail />} />
                <Route path="/quiz" element={<Quiz />} />
                <Route path="/review" element={<Review />} />
                <Route path="/mistakes" element={<Mistakes />} />
                <Route path="/stats" element={<Stats />} />
                <Route path="/lab" element={<Lab />} />
                <Route path="/blitz" element={<Blitz />} />
                <Route path="/deck" element={<Deck />} />
                <Route path="/chat" element={<Chat />} />
                <Route path="/classroom" element={<Classroom />} />
                <Route path="/achievements" element={<Achievements />} />
                <Route path="/settings" element={<Settings />} />
                {/* 管理台。这里不做角色判断 —— 页面自己会检查并跳回首页。
                 * 真正的门在服务端：/api/admin/* 每条路由都挂 requireAdmin，
                 * 非管理员即便把这一行删掉也拿不到数据。 */}
                <Route path="/admin" element={<Admin />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </motion.div>
        ) : (
          <motion.div key="auth" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          </motion.div>
        )}
      </AnimatePresence>
    </BrowserRouter>
  );
}

/* 注意：这个组件渲染在 <BrowserRouter> 外面。
 * 曾经这里写了 `const location = useLocation()` —— 那是硬崩：
 * 「useLocation() may be used only in the context of a <Router> component」，
 * 整个应用首屏直接白屏。别在这里用任何 react-router 的 hook。 */
function BootScreen() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-4">
        <div className="relative grid h-14 w-14 place-items-center">
          <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-cyan/25 to-violet/20 blur-lg" />
          <span className="relative grid h-12 w-12 place-items-center rounded-2xl border border-veil/12 bg-veil/5 text-[20px] font-semibold">
            <span className="text-aurora">∫</span>
          </span>
        </div>
        <div className="h-1 w-32 overflow-hidden rounded-full bg-veil/8">
          <div className="h-full w-1/2 animate-[skeleton_1.2s_ease_infinite] rounded-full bg-gradient-to-r from-cyan to-violet" />
        </div>
      </div>
    </div>
  );
}
