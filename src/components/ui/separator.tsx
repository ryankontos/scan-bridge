import { cn } from '../../lib/utils'

function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-zinc-200 dark:bg-zinc-800', className)} />
}

export { Separator }
