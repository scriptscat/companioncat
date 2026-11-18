/**
 * The selection entry runtime (R9.6–R9.9, R10): watches the host page's selection, confirms
 * (paw / none / alt), runs the entry's steps and shows the near-selection card. Everything it
 * renders lives in the shell's shadow root; the host page DOM is only read, never changed.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderTemplate } from "../../core/expr";
import { POSITIONS } from "../../core/rules/positions";
import type { SurfaceDef, ViewTemplateDef } from "../../core/rules/types";
import { createSettingsStore } from "../../core/stores";
import { featureTarget, type RuntimeContext } from "../../shell";
import { PortalContainer } from "../../ui";
import type { ResultItem, ViewAction } from "../../views";
import { elementOf, endRect, rangeRect, selectionContext } from "./context";
import { reload } from "./items";
import { Overlay } from "./Overlay";
import { invokerFor } from "./services";
import { invokeInto, runSteps, type StepEnv, type Vars } from "./steps";
import { createStore, type CardState } from "./store";
import { pick, type Chosen } from "./triggers";

const CLOSE_ON = ["escape", "outside-click", "new-selection"] as const;
type CloseReason = (typeof CLOSE_ON)[number];

/** Keys that finish a keyboard selection. */
const selectingKey = (e: KeyboardEvent) =>
  e.shiftKey || /^(Shift$|Arrow|Home$|End$|Page)/.test(e.key) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a");
/** macOS sends no key-up for A while Cmd is held: the modifier's own key-up ends Cmd+A / Ctrl+A. */
const modifierKey = (e: KeyboardEvent) => e.key === "Meta" || e.key === "Control";

const sameRange = (a: Range, b: Range) => {
  try {
    return a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
  } catch {
    return false; // different documents
  }
};

export function startSelection(ctx: RuntimeContext): () => void {
  const { root, services, hostname } = ctx;
  const host = root.host;
  const doc = host.ownerDocument;
  const win = doc.defaultView ?? window;
  const store = createStore();
  const settings = createSettingsStore(services.storage);
  const invoker = invokerFor(services);
  /** Per open card: its running steps, the entry it shows and the selection it points at. */
  const runs = new Map<number, AbortController>();
  const chosenOf = new Map<number, Chosen>();
  const ranges = new Map<number | "paw", Range>();
  let nextId = 1;
  let seq = 0;
  let awake = false;
  let disposed = false;
  /** The selection changed since it was last considered (gates the modifier key-up). */
  let changed = false;
  const timers = new Set<number>();

  const ownNode = (n: Node | null | undefined) => !!n && (n === host || n.getRootNode() === root || host.contains(n));
  const fromOwnUi = (e: Event) => e.composedPath().includes(host);
  const nameOf = (ref: string) => services.rules.get().providers.find((p) => p.ref === ref)?.def.name;
  const views = () =>
    Object.fromEntries(services.rules.get().views.map((v) => [v.ref, v.def])) as Readonly<Record<string, ViewTemplateDef>>;

  const unsubAwake = store.subscribe(() => {
    const { paw, cards } = store.get();
    const on = !!paw || cards.length > 0;
    if (on !== awake) ctx.setAwake((awake = on));
  });

  const hidePaw = () => {
    if (!store.get().paw) return;
    ranges.delete("paw");
    store.set({ paw: null });
  };

  function closeCard(id: number) {
    runs.get(id)?.abort();
    runs.delete(id);
    chosenOf.delete(id);
    ranges.delete(id);
    store.set({ cards: store.get().cards.filter((c) => c.id !== id) });
  }

  /** Closes the unpinned cards that close for `reason` (pinned cards only close by hand). */
  function autoClose(reason: CloseReason) {
    let any = false;
    for (const c of store.get().cards) {
      if (!c.pinned && c.closeOn.includes(reason)) {
        closeCard(c.id);
        any = true;
      }
    }
    return any;
  }

  function envFor(id: number, signal: AbortSignal): StepEnv {
    return {
      invoker,
      nameOf,
      signal,
      confirmHost: services.confirmHost,
      vars: {
        get: () => store.card(id)?.vars ?? {},
        set: (vars: Vars) => {
          if (!signal.aborted) store.patchCard(id, { vars });
        },
      },
      onCall: (call) => {
        const c = store.card(id);
        if (c && !signal.aborted) store.patchCard(id, { calls: [...c.calls.filter((x) => x.as !== call.as), call] });
      },
    };
  }

  /** Runs the entry's steps for card `id` (again, with temporary vars, on rerun). */
  async function execute(id: number, overrides: Vars) {
    if (disposed) return;
    runs.get(id)?.abort();
    const ctrl = new AbortController();
    runs.set(id, ctrl);
    store.patchCard(id, { overrides, calls: [], error: undefined });
    const card = store.card(id);
    const chosen = chosenOf.get(id);
    if (!card || !chosen) return;
    const out = await runSteps(chosen.entry.def.run, card.scope, envFor(id, ctrl.signal), overrides);
    if (!ctrl.signal.aborted && out.error !== undefined) store.patchCard(id, { error: out.error });
  }

  async function retry(id: number, engine: string) {
    const card = store.card(id);
    const ctrl = runs.get(id);
    const call = card?.calls.find((c) => (card.vars[c.as] as ResultItem[] | undefined)?.some?.((it) => it.engine === engine));
    if (!card || !ctrl || !call) return;
    const env = envFor(id, ctrl.signal);
    env.vars.set({ ...card.vars, [call.as]: reload(card.vars[call.as] as ResultItem[], engine) });
    try {
      await invokeInto(call, [engine], "first", env);
    } catch {
      // cancelled: the card was closed or rerun
    }
  }

  async function open(chosen: Chosen, range: Range) {
    const selection = selectionContext(range);
    const scope = { settings: chosen.settings, selection, page: chosen.page, site: chosen.site };
    let surface: Partial<SurfaceDef> = {};
    try {
      surface = (await renderTemplate(chosen.entry.def.present!.surface, { ...scope, vars: {} }, POSITIONS.surface)) as SurfaceDef;
    } catch {
      surface = {};
    }
    if (disposed) return;
    hidePaw();
    // one unpinned card at a time; pinned ones stay
    for (const c of store.get().cards) if (!c.pinned) closeCard(c.id);
    const id = nextId++;
    chosenOf.set(id, chosen);
    ranges.set(id, range);
    const card: CardState = {
      id,
      title: chosen.feature.def.name,
      view: chosen.entry.def.present!.view,
      scope,
      vars: {},
      overrides: {},
      calls: [],
      pinnable: surface.pinnable === true,
      closeOn: Array.isArray(surface.closeOn) ? surface.closeOn : CLOSE_ON,
      pinned: false,
      anchor: selection.rect,
    };
    store.set({ cards: [...store.get().cards, card] });
    await execute(id, {});
  }

  function onAction(card: CardState, a: ViewAction) {
    if ("retry" in a) void retry(card.id, String(a.retry));
    else if ("rerun" in a) void execute(card.id, { ...(store.card(card.id)?.overrides ?? {}), ...a.rerun.vars });
    else if ("open" in a) {
      // `feature-settings` is the page of the feature this card belongs to (R9.12)
      const to = String(a.open);
      const feature = chosenOf.get(card.id)?.feature;
      ctx.openSettings(to === "feature-settings" && feature ? featureTarget(feature) : to);
    }
    else if ("surface" in a) {
      if (a.surface === "close") closeCard(card.id);
      else if (a.surface === "pin" && card.pinnable) store.patchCard(card.id, { pinned: !store.card(card.id)?.pinned });
    }
  }

  async function consider(alt: boolean, target: Element | null) {
    if (disposed) return;
    const mine = ++seq;
    const fresh = changed;
    changed = false;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0).cloneRange();
    if (ownNode(range.commonAncestorContainer) || ownNode(sel.anchorNode) || ownNode(sel.focusNode)) return;
    // an unchanged selection the paw or a card already points at (e.g. a key-up that only scrolled)
    if (!fresh) for (const r of ranges.values()) if (sameRange(r, range)) return;
    const text = sel.toString().trim();
    if (!text) return;
    hidePaw();
    autoClose("new-selection");
    const active = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    const elements = [elementOf(range.startContainer), elementOf(range.endContainer), target, active].filter((x): x is Element => !!x);
    const chosen = await pick({
      resolved: services.rules.get(),
      storage: services.storage,
      settings,
      hostname,
      url: win.location.href,
      title: doc.title,
      text,
      elements,
    });
    if (disposed || mine !== seq || !chosen) return;
    if (chosen.confirm === "none" || (chosen.confirm === "alt" && alt)) void open(chosen, range);
    else if (chosen.confirm === "paw") {
      ranges.set("paw", range);
      const end = elementOf(range.endContainer);
      const rtl = !!end && win.getComputedStyle(end).direction === "rtl";
      store.set({ paw: { title: chosen.feature.def.name, anchor: endRect(range), rtl, go: () => void open(chosen, range) } });
    }
  }

  const onRelease = (e: MouseEvent | KeyboardEvent) => {
    if (fromOwnUi(e)) return;
    if (e instanceof KeyboardEvent && !selectingKey(e) && !(modifierKey(e) && changed)) return;
    const target = e.target instanceof Element ? e.target : null;
    const alt = e.altKey;
    const t = win.setTimeout(() => {
      timers.delete(t);
      void consider(alt, target);
    }, 0);
    timers.add(t);
  };
  const onMouseDown = (e: MouseEvent) => {
    if (fromOwnUi(e)) return;
    seq++;
    hidePaw();
    autoClose("outside-click");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // a modal window of ours (settings, host dialog) is open: Esc closes that first (R1.5)
    if (root.querySelector('[aria-modal="true"]')) return;
    const hadPaw = !!store.get().paw;
    hidePaw();
    if (autoClose("escape") || hadPaw) e.preventDefault();
  };
  const onSelectionChange = () => {
    changed = true;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) hidePaw();
  };
  let frame: ReturnType<typeof setTimeout> | number | 0 = 0;
  const later = (cb: () => void) => (typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame(cb) : win.setTimeout(cb, 16));
  const cancel = (h: typeof frame) => (typeof win.cancelAnimationFrame === "function" ? win.cancelAnimationFrame(h as number) : win.clearTimeout(h));
  /** Unpinned cards and the paw follow the selection when the page scrolls or resizes. */
  const onMove = () => {
    if (frame) return;
    frame = later(() => {
      frame = 0;
      const { paw, cards } = store.get();
      const pr = ranges.get("paw");
      if (paw && pr) store.set({ paw: { ...paw, anchor: endRect(pr) } });
      for (const c of cards) {
        const r = ranges.get(c.id);
        if (r && !c.pinned) store.patchCard(c.id, { anchor: rangeRect(r) });
      }
    });
  };

  doc.addEventListener("mouseup", onRelease, true);
  doc.addEventListener("keyup", onRelease, true);
  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("selectionchange", onSelectionChange);
  win.addEventListener("scroll", onMove, true);
  win.addEventListener("resize", onMove);

  const mountEl = doc.createElement("div");
  mountEl.dataset.ccSelection = "";
  ctx.layer.append(mountEl);
  const reactRoot = createRoot(mountEl);
  flushSync(() =>
    reactRoot.render(
      <PortalContainer value={ctx.layer}>
        <Overlay store={store} views={views} onAction={onAction} />
      </PortalContainer>,
    ),
  );

  return () => {
    disposed = true;
    seq++;
    for (const t of timers) win.clearTimeout(t);
    timers.clear();
    doc.removeEventListener("mouseup", onRelease, true);
    doc.removeEventListener("keyup", onRelease, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("selectionchange", onSelectionChange);
    win.removeEventListener("scroll", onMove, true);
    win.removeEventListener("resize", onMove);
    if (frame) cancel(frame);
    for (const c of runs.values()) c.abort();
    runs.clear();
    chosenOf.clear();
    ranges.clear();
    store.set({ paw: null, cards: [] });
    unsubAwake();
    reactRoot.unmount();
    mountEl.remove();
  };
}
