import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-[28px] border border-[var(--app-border)] bg-[var(--app-surface)] p-5 text-[var(--app-text)] shadow-2xl shadow-black/15 backdrop-blur-xl',
        className,
      )}
      {...props}
    />
  )
}
