import { cn } from 'cn';
import { Star, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StarRowProps {
  stars: number;
  del: boolean;
  canUndo: boolean;
  onStar: (n: number) => void;
  onDel: () => void;
  onUndo: () => void;
}

/**
 * 星级行：撤销 · 1-5 星 · 待删。
 * 星级是唯一的「喜欢程度」表达，待删与星级互斥（打星即恢复，待删即清零）。
 */
export function StarRow({ stars, del, canUndo, onStar, onDel, onUndo }: StarRowProps) {
  return (
    <div className="flex items-center justify-between gap-1 px-2 pb-1">
      <Button
        variant="ghost"
        size="icon-lg"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="撤销上一步"
        className="rounded-full text-muted-foreground"
      >
        <Undo2 className="size-5" />
      </Button>

      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <Button
            key={n}
            variant="ghost"
            size="icon-lg"
            aria-label={`${n} 星`}
            aria-pressed={n <= stars}
            onClick={() => onStar(n)}
            className={cn('rounded-full text-muted-foreground/70 hover:text-gold', n <= stars && 'text-gold')}
          >
            <Star className={cn('size-5', n <= stars && 'fill-gold')} />
          </Button>
        ))}
      </div>

      <Button
        variant="ghost"
        size="lg"
        onClick={onDel}
        aria-pressed={del}
        className={cn('gap-1.5 text-muted-foreground', del && 'bg-danger/15 text-danger hover:text-danger')}
      >
        <Trash2 className="size-4" />
        <span className="text-xs">待删</span>
      </Button>
    </div>
  );
}
