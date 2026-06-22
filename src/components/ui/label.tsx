import type { LabelHTMLAttributes } from 'react'

import { cn } from '../../lib/utils'

function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-sm font-medium text-zinc-700 dark:text-zinc-300', className)}
      {...props}
    />
  )
}

export { Label }
