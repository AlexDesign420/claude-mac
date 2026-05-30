import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex min-w-0 items-center justify-center rounded-2xl border text-[15px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]/45 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-[var(--app-accent)]/35 bg-[var(--app-accent)] text-[#fffaf3] shadow-lg shadow-black/15 hover:brightness-110',
        secondary: 'border-[var(--app-border)] bg-[var(--app-surface)] text-[var(--app-text)] hover:bg-[var(--app-surface-elevated)]',
        destructive: 'border-[var(--app-error)]/30 bg-[var(--app-error)] text-white hover:brightness-110',
      },
      size: {
        default: 'h-11 px-4 py-2',
        sm: 'h-9 px-3 py-2 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
