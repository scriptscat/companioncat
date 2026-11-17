// 陪伴猫 基础组件（原型 v5 ui.tsx）：行为用 Radix 无样式原语，外观全部来自 styles.css 的令牌
import type React from "react";
import { createContext, useContext, type ReactNode } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  Checkbox as CheckboxPrimitive,
  DropdownMenu as MenuPrimitive,
  Select as SelectPrimitive,
  Switch as SwitchPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

// ---------- 弹出层容器 ----------

/** Where Radix portals mount: a node inside the shadow root (R1.2). Undefined only outside the shell. */
const PortalCtx = createContext<HTMLElement | null>(null);
export const PortalContainer = PortalCtx.Provider;
export const usePortalContainer = () => useContext(PortalCtx) ?? undefined;

// ---------- 按钮 ----------

type BtnProps = React.ComponentProps<"button"> & {
  variant?: "primary" | "outline" | "plain" | "danger" | "soft";
  size?: "xs" | "sm" | "md";
};

export function Btn({ variant = "primary", size = "md", className, ...p }: BtnProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
        size === "md" && "h-10 rounded-full px-5 text-[14px] [&_svg]:size-4",
        size === "sm" && "h-8 rounded-full px-3.5 text-[13px] [&_svg]:size-3.5",
        size === "xs" && "h-7 rounded-full px-3 text-[12px] [&_svg]:size-3.5",
        variant === "primary" && "bg-ginger text-on-ginger hover:bg-ginger-hover",
        variant === "soft" && "bg-ginger-soft text-ginger-ink hover:brightness-[0.97] dark:hover:brightness-110",
        variant === "outline" && "border-[1.5px] border-line-strong bg-fur font-medium text-ink hover:border-ink-3",
        variant === "plain" && "font-medium text-ink-2 hover:bg-sunken hover:text-ink",
        variant === "danger" && "font-medium text-berry hover:bg-berry-soft",
        className
      )}
      {...p}
    />
  );
}

export function IconBtn({
  icon: Icon,
  label,
  size = 32,
  active,
  className,
  ...p
}: Omit<React.ComponentProps<"button">, "children"> & { icon: LucideIcon; label: string; size?: number; active?: boolean }) {
  const container = usePortalContainer();
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-sunken hover:text-ink disabled:opacity-35",
            active && "bg-patch text-on-patch hover:bg-patch hover:text-on-patch",
            className
          )}
          style={{ width: size, height: size }}
          {...p}
        >
          <Icon className={size >= 30 ? "size-[18px]" : "size-4"} strokeWidth={1.9} />
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Content sideOffset={6} className="cc z-[100] rounded-full bg-patch px-2.5 py-1 text-[12px] text-on-patch">
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TipProvider = TooltipPrimitive.Provider;

// ---------- 开关 / 复选 ----------

export function Toggle(p: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      {...p}
      className={cn(
        "relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
        "data-[state=checked]:bg-ginger data-[state=unchecked]:bg-line-strong",
        p.className
      )}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-[2px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/.25)] transition-transform data-[state=checked]:translate-x-[20px]" />
    </SwitchPrimitive.Root>
  );
}

export function Tick(p: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      {...p}
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border-[1.5px] border-line-strong bg-fur",
        "data-[state=checked]:border-ginger data-[state=checked]:bg-ginger data-[state=checked]:text-on-ginger",
        p.className
      )}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3" strokeWidth={3.2} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

// ---------- 下拉选择 ----------

export function Picker({
  value,
  defaultValue,
  onValueChange,
  options,
  label,
  className,
  compact,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  options: { value: string; label: ReactNode }[];
  label: string;
  className?: string;
  compact?: boolean;
}) {
  const container = usePortalContainer();
  return (
    <SelectPrimitive.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(
          "inline-flex items-center justify-between gap-1.5 text-left text-ink",
          compact ? "h-8 rounded-full px-3 text-[13px] font-medium hover:bg-sunken" : "h-10 w-full rounded-xl border-[1.5px] border-line bg-fur px-3 text-[14px] hover:border-line-strong",
          className
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-ink-3" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="cc sticker z-[100] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-2xl bg-fur p-1"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="flex h-9 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-[14px] outline-none data-[highlighted]:bg-sunken"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check className="size-4 text-ginger-ink" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---------- 菜单 ----------

export type MenuItem = { label: string; icon?: LucideIcon; danger?: boolean; disabled?: boolean; onSelect?: () => void } | "sep";

export function Menu({ trigger, items }: { trigger: ReactNode; items: MenuItem[] }) {
  const container = usePortalContainer();
  return (
    // not modal: a modal menu marks the host page's <body> aria-hidden and scroll-locked (R1.2)
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal container={container}>
        <MenuPrimitive.Content align="end" sideOffset={4} className="cc sticker z-[100] min-w-40 rounded-2xl bg-fur p-1">
          {items.map((it, i) =>
            it === "sep" ? (
              <MenuPrimitive.Separator key={i} className="mx-2 my-1 h-px bg-line" />
            ) : (
              <MenuPrimitive.Item
                key={it.label}
                disabled={it.disabled}
                onSelect={it.onSelect}
                className={cn(
                  "flex h-9 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-[14px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-sunken",
                  it.danger && "text-berry data-[highlighted]:bg-berry-soft"
                )}
              >
                {it.icon && <it.icon className="size-4 opacity-80" />}
                {it.label}
              </MenuPrimitive.Item>
            )
          )}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

// ---------- 分段选择 ----------

export function Segments<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full bg-sunken p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 flex-1 rounded-full px-3 text-[13px] whitespace-nowrap text-ink-2 transition-colors hover:text-ink",
            value === o.value && "bg-patch font-semibold text-on-patch hover:text-on-patch"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- 输入 ----------

export function TextInput({ className, ...p }: React.ComponentProps<"input">) {
  return (
    <input
      {...p}
      className={cn(
        "h-10 w-full rounded-xl border-[1.5px] border-line bg-fur px-3 text-[14px] text-ink placeholder:text-ink-3 hover:border-line-strong focus:border-ink focus:outline-none aria-[invalid=true]:border-berry",
        className
      )}
    />
  );
}

// ---------- 结构 ----------

export function Section({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      {(title || aside) && (
        <div className="mb-2 flex min-h-6 items-end justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-ink-2">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? <p className="text-[12.5px] leading-relaxed text-berry">{error}</p> : hint && <p className="text-[12.5px] leading-relaxed text-ink-3">{hint}</p>}
    </div>
  );
}

// 设置行：标签 + 说明 + 右侧控件，行与行之间一条细线
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function Tag({ tone = "ginger", children }: { tone?: "ginger" | "leaf" | "berry" | "plain" | "patch"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-semibold",
        tone === "ginger" && "bg-ginger-soft text-ginger-ink",
        tone === "leaf" && "bg-leaf-soft text-leaf",
        tone === "berry" && "bg-berry-soft text-berry",
        tone === "plain" && "bg-sunken text-ink-2",
        tone === "patch" && "bg-patch text-on-patch"
      )}
    >
      {children}
    </span>
  );
}

export function Monogram({ letter, size = 34, className }: { letter: string; size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-sunken font-semibold text-ink-2", className)}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

// 状态点：引擎能不能用
export function Dot({ tone }: { tone: "leaf" | "ginger" | "berry" | "off" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "leaf" && "bg-leaf",
        tone === "ginger" && "bg-ginger",
        tone === "berry" && "bg-berry",
        tone === "off" && "bg-line-strong"
      )}
    />
  );
}

// 没有规则时的空状态（原型 v5 rules.tsx）
export function EmptyRules({
  title,
  body,
  onSubscribe,
  disabled,
  children,
}: {
  title: string;
  body: ReactNode;
  onSubscribe?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-10 text-center">
      <p className="text-[16px] font-bold">{title}</p>
      <p className="mt-1.5 max-w-[340px] text-[13px] leading-relaxed text-ink-2">{body}</p>
      {onSubscribe && (
        <Btn size="sm" className="mt-4" onClick={onSubscribe} disabled={disabled}>
          订阅官方规则
        </Btn>
      )}
      {children}
    </div>
  );
}
