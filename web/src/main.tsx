import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './app/App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在：检查 index.html');

createRoot(container).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
