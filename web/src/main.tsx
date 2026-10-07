import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './app/App';
import { AnnotatePage } from '@/features/jobs/AnnotatePage';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在：检查 index.html');

// `/j?t=<范围 token>` 是给外部批注人的独立一页：不套 App 外壳（没有侧栏、没有目录树、没有管理入口），
// 也不进 store 的 boot —— 它的全部凭据就是 URL 里那条 token。
const isAnnotatePage = window.location.pathname.replace(/\/+$/, '') === '/j';

createRoot(container).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>{isAnnotatePage ? <AnnotatePage /> : <App />}</TooltipProvider>
  </StrictMode>,
);
