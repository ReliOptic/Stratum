import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs font-medium leading-none tracking-tight tabular-nums",
  {
    variants: {
      variant: {
        default: "bg-secondary text-text",
        amber: "bg-amber/15 text-amber",
        cyan: "bg-cyan/15 text-cyan",
        olive: "bg-olive/15 text-olive",
        confirm: "bg-confirm/15 text-confirm",
        danger: "bg-danger/15 text-danger",
        dim: "bg-secondary/70 text-dim",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({
  className,
  variant,
  ...props
}: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
