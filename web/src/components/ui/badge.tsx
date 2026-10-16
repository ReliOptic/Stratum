import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-xs font-medium leading-none tracking-tight",
  {
    variants: {
      variant: {
        default: "border-hairline bg-panel text-text",
        amber: "border-amber/60 bg-amber/15 text-amber",
        cyan: "border-cyan/60 bg-cyan/15 text-cyan",
        olive: "border-olive/60 bg-olive/15 text-olive",
        confirm: "border-confirm/60 bg-confirm/15 text-confirm",
        danger: "border-danger/60 bg-danger/15 text-danger",
        dim: "border-hairline bg-bg text-dim",
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
