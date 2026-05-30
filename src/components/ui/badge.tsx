import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

const variants = {
  success: 'border-[var(--app-success)]/30 bg-[var(--app-success)]/14 text-[var(--app-text)]',
  info: 'border-[var(--app-accent-2)]/35 bg-[var(--app-accent-2)]/14 text-[var(--app-text)]',
  muted: 'border-[var(--app-border)] bg-[var(--app-surface)] text-[var(--app-text-secondary)]',
}

export function Badge({ className, variant = 'muted', ...props }: HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-xs font-medium tracking-wide',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}
