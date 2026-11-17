import { Component, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Boxes, Cpu, Puzzle, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { knownIcon } from "../views/icons";
import { Cat, type CatBreed } from "../ui/cat";
import { cn, EmptyRules, IconBtn, Segments } from "../ui/ui";
import { useShell } from "./context";
import { BUILTIN_PAGES, type BuiltinPage, type PageRegistration } from "./registry";
import { SubscribeEmpty } from "./SubscribeEmpty";
import { engineOfTarget, featureTarget } from "./targets";

// 外壳自带的页面：没有任何规则时也存在（R1.5）
const BUILTIN: Record<BuiltinPage, { label: string; icon: LucideIcon }> = {
  engines: { label: "引擎", icon: Cpu },
  rules: { label: "规则", icon: Boxes },
  general: { label: "通用", icon: SlidersHorizontal },
};

interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  render: () => ReactNode;
}

const TABBABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** 设置窗口外壳（原型 v5 manager.tsx 的 Manager）：页面内容由各页注册，这里只有导航、标题和关闭。 */
export function Settings({
  target,
  pages,
  breed,
  version,
  onNavigate,
  onClose,
  onUnmount,
}: {
  target: string;
  pages: PageRegistration[];
  breed: CatBreed;
  version?: string;
  onNavigate: (to: string) => void;
  onClose: () => void;
  /** Runs when the window goes away: focus goes back to whatever opened it. */
  onUnmount: () => void;
}) {
  const shell = useShell();
  const { narrow, bare, resolved } = shell;
  const ref = useRef<HTMLDivElement>(null);
  const featuresId = useId();
  const companionId = useId();
  const unmount = useRef(onUnmount);
  unmount.current = onUnmount;

  useLayoutEffect(() => {
    ref.current?.focus();
    return () => unmount.current();
  }, []);

  const featurePage = pages.find((p) => p.group === "features");
  const pageFor = (id: string) => pages.find((p) => p.group === "companion" && p.id === id);
  const placeholder = (label: string) => <EmptyRules title={label} body="这一页还在准备中。" />;

  const features: NavItem[] = resolved.features.map((f) => ({
    key: featureTarget(f),
    label: f.def.name,
    // rule features name their icon like views do (e.g. "languages"); unknown names get a puzzle piece
    icon: knownIcon(f.def.icon) ?? Puzzle,
    // keyed: another feature's page must not inherit this one's drafts
    render: () => (featurePage ? <featurePage.component key={f.ref} feature={f} narrow={narrow} /> : placeholder(f.def.name)),
  }));
  const companion: NavItem[] = [
    ...BUILTIN_PAGES.map((id) => ({ key: id, ...BUILTIN[id], page: pageFor(id) })),
    ...pages
      .filter((p) => p.group === "companion" && !(BUILTIN_PAGES as readonly string[]).includes(p.id))
      .map((p) => ({ key: p.id, label: p.label ?? p.id, icon: p.icon ?? Puzzle, page: p })),
  ].map(({ page, ...item }) => ({
    ...item,
    render: () =>
      item.key === "engines" && bare ? (
        <div className="flex h-full flex-col items-center justify-center">
          <Cat breed={breed} size={110} zzz />
          <SubscribeEmpty title="陪伴猫还什么都不会" body="引擎由规则提供。订阅官方规则后，Google、微软翻译和常见大模型会出现在这里。" />
        </div>
      ) : page ? (
        <page.component narrow={narrow} target={target} />
      ) : (
        placeholder(item.label)
      ),
  }));
  const all = [...features, ...companion];
  // `engine:<ref>` is the engines page with that engine open (R9.12)
  const key = engineOfTarget(target) ? "engines" : target;
  const current = all.find((n) => n.key === key) ?? companion[0]!;

  const navButton = (n: NavItem) => {
    const on = n.key === current.key;
    return (
      <button
        key={n.key}
        type="button"
        aria-current={on ? "page" : undefined}
        onClick={() => onNavigate(n.key)}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-full px-3.5 text-[14px] transition-colors",
          on ? "bg-patch font-semibold text-on-patch" : "text-ink-2 hover:bg-sunken hover:text-ink",
        )}
      >
        <n.icon className="size-[17px]" strokeWidth={2} />
        {n.label}
      </button>
    );
  };

  // 焦点留在窗口里（R13.3）
  const trapTab = (e: React.KeyboardEvent) => {
    const box = ref.current;
    if (e.key !== "Tab" || !box || !box.contains(e.target as Node)) return;
    const list = [...box.querySelectorAll<HTMLElement>(TABBABLE)];
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = shell.root.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={cn("cc fixed inset-0 z-40 flex items-center justify-center bg-scrim", !narrow && "p-6")}
      // clicking the scrim must not move focus out of the window
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="陪伴猫设置"
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          "cc-pop flex overflow-hidden bg-paper focus:outline-none",
          narrow ? "h-full w-full flex-col" : "sticker h-[min(640px,100%)] w-[min(940px,100%)] rounded-[28px]",
        )}
      >
        {narrow ? (
          <div className="shrink-0 border-b border-line bg-fur px-4 pt-3 pb-3">
            <div className="flex items-center gap-2">
              <Cat breed={breed} size={36} />
              <h2 className="flex-1 text-[17px] font-bold">陪伴猫</h2>
              <IconBtn icon={X} label="关闭" onClick={onClose} />
            </div>
            <div className="mt-3">
              <Segments label="设置分区" value={current.key} onChange={onNavigate} options={all.map((n) => ({ value: n.key, label: n.label }))} />
            </div>
          </div>
        ) : (
          <aside className="flex w-[212px] shrink-0 flex-col border-r border-line px-3 pt-5 pb-4">
            <div className="flex items-center gap-2 px-2">
              <Cat breed={breed} size={46} zzz />
              <span className="text-[18px] font-bold tracking-tight">陪伴猫</span>
            </div>

            <nav aria-label="设置分区" className="flex flex-col">
              <p id={featuresId} className="mt-6 px-3.5 pb-1.5 text-[12px] font-semibold text-ink-3">
                功能
              </p>
              <div role="group" aria-labelledby={featuresId} className="flex flex-col gap-1">
                {features.length ? (
                  features.map(navButton)
                ) : (
                  <p className="px-3.5 text-[12.5px] leading-relaxed text-ink-3">还没有功能。功能由规则提供，订阅规则后出现在这里。</p>
                )}
              </div>

              <p id={companionId} className="mt-5 px-3.5 pb-1.5 text-[12px] font-semibold text-ink-3">
                陪伴猫
              </p>
              <div role="group" aria-labelledby={companionId} className="flex flex-col gap-1">
                {companion.map(navButton)}
              </div>
            </nav>

            {version && <p className="mt-auto px-3 text-[12.5px] text-ink-3">版本 {version}</p>}
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {!narrow && (
            <header className="flex h-16 shrink-0 items-center gap-2 px-6">
              <h2 className="flex-1 text-[20px] font-bold tracking-tight">{current.label}</h2>
              <IconBtn icon={X} label="关闭 (Esc)" onClick={onClose} />
            </header>
          )}
          <div className="min-h-0 flex-1">
            <PageBoundary key={current.key}>{current.render()}</PageBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

/** One page failing to render (e.g. a rule with unexpected data) must not unmount the whole shell. */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override componentDidCatch(error: unknown) {
    console.error("[陪伴猫] settings page failed to render", error);
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="m-6 rounded-[18px] bg-berry-soft px-4 py-3 text-[13.5px] leading-relaxed text-berry">
        这一页出错了：{error.message}
      </div>
    );
  }
}
