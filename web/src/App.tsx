import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '@/stores/auth';
import { AppShell } from '@/components/layout/AppShell';

import Login from '@/pages/Login';
import Register from '@/pages/Register';

/* 页面级路由搬到了 routes.tsx —— 因为顶栏面包屑也要用同一张表。
 * 这里只剩「登录 / 未登录」这一层分支：登录后整块交给 AppShell，
 * 由它里面的 KeepAlivePages 按路由表切换页面（带保活）。 */
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
            <AppShell />
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
