import * as React from "react";
import { cn } from "@/lib/utils";

interface DropdownContextValue {
  readonly open: boolean;
  readonly setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

export interface DropdownMenuProps {
  readonly children: React.ReactNode;
}

export function DropdownMenu({ children }: DropdownMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState<boolean>(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const value = React.useMemo(() => ({ open, setOpen }), [open]);

  return (
    <DropdownContext.Provider value={value}>
      <div ref={containerRef} className="relative inline-flex">
        {children}
      </div>
    </DropdownContext.Provider>
  );
}

export interface DropdownMenuTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: React.ReactNode;
}

export function DropdownMenuTrigger({
  className,
  children,
  ...props
}: DropdownMenuTriggerProps): React.JSX.Element {
  const ctx = React.useContext(DropdownContext);
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={ctx?.open ?? false}
      onClick={() => ctx?.setOpen((prev) => !prev)}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-secondary/80 px-3 py-1.5 font-sans text-xs font-medium text-text transition-colors duration-150 ease-out hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly children: React.ReactNode;
  readonly align?: "start" | "end";
}

export function DropdownMenuContent({
  className,
  children,
  align = "start",
  ...props
}: DropdownMenuContentProps): React.JSX.Element | null {
  const ctx = React.useContext(DropdownContext);
  if (!ctx?.open) return null;
  return (
    <div
      role="menu"
      className={cn(
        "absolute bottom-full z-50 mb-2 min-w-36 rounded-lg bg-panel p-1 shadow-xl",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface DropdownMenuItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly active?: boolean;
}

export function DropdownMenuItem({
  className,
  active = false,
  onClick,
  children,
  ...props
}: DropdownMenuItemProps): React.JSX.Element {
  const ctx = React.useContext(DropdownContext);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        onClick?.(e);
        ctx?.setOpen(false);
      }}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left font-sans text-xs transition-colors duration-150 ease-out",
        active ? "bg-amber/15 text-amber" : "text-text hover:bg-secondary",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
