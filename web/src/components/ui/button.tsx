import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-mono text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-amber text-bg hover:bg-amber/90",
        outline: "border border-hairline bg-panel text-text hover:border-amber/60 hover:text-amber",
        ghost: "bg-transparent text-dim hover:bg-panel hover:text-text",
        cyan: "border border-cyan/50 bg-cyan/10 text-cyan hover:bg-cyan/20",
        confirm: "border border-confirm/50 bg-confirm/15 text-confirm hover:bg-confirm/25",
        danger: "border border-danger/50 bg-danger/15 text-danger hover:bg-danger/25",
      },
      size: {
        default: "h-8 px-3 py-1.5",
        sm: "h-7 px-2.5 py-1",
        lg: "h-9 px-4 py-2",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
