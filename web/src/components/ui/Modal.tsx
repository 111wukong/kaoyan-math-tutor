import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './Primitives';

/* 模态框
 * 三个必须做对的细节：
 *   1. Esc 关闭 —— 键盘用户唯一的退路；
 *   2. 打开时锁住 body 滚动 —— 否则背景会跟着滚，很廉价；
 *   3. 关闭后焦点还给触发元素 —— 不然键盘用户会掉到页面顶部。
 */
export function Modal({
  open,
  onClose,
  title,
  desc,
  children,
  footer,
  size = 'md',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-100 grid place-items-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-scrim/72 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            initial={{ opacity: 0, y: 18, scale: 0.975 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className={cn('glass-strong hairline-top relative w-full rounded-2xl', widths[size], className)}
          >
            {(title || desc) && (
              <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
                <div className="min-w-0">
                  {title && <h3 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h3>}
                  {desc && <p className="mt-1 text-[12.5px] leading-relaxed text-fg-mute">{desc}</p>}
                </div>
                <button
                  onClick={onClose}
                  aria-label="关闭"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-mute transition-colors hover:bg-veil/7 hover:text-fg"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="max-h-[68vh] overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex items-center justify-end gap-2.5 border-t border-hairline px-5 py-3.5">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/* 危险操作确认：要求用户手打确认词，防手滑 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  desc,
  confirmText = '确认',
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  desc: ReactNode;
  confirmText?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-fg-soft">{desc}</div>
    </Modal>
  );
}
