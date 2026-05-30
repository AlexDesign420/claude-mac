import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function SafeText({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn('min-w-0 max-w-full break-words text-[var(--app-text-secondary)]', className)} {...props}>
      {children}
    </span>
  )
}

export function PathText({ value, className }: { value?: string | null; className?: string }) {
  return (
    <span
      className={cn('block max-w-full truncate font-mono text-[13px] text-[var(--app-muted)]', className)}
      title={value || undefined}
    >
      {value || 'nicht gesetzt'}
    </span>
  )
}

export function LogBlock({ value, className }: { value?: string | null; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-[var(--app-border)] bg-black/20 p-3 font-mono text-[13px] leading-relaxed text-[var(--app-text-secondary)]',
        className,
      )}
    >
      {value || '(leer)'}
    </pre>
  )
}

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return <LogBlock className={className} value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} />
}

export function ErrorPanel({
  title,
  children,
  actions,
  className,
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-[28px] border border-[var(--app-error)]/30 bg-[var(--app-error)]/10 p-5', className)}>
      <p className="text-[15px] font-semibold text-[var(--app-text)]">{title}</p>
      {children ? <div className="mt-3 min-w-0 space-y-2 text-sm text-[var(--app-text-secondary)]">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
