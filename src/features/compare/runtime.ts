/**
 * 网页对照 (R7.1–R7.5): every entry whose present surface is `inline-after` gets its command
 * (bubble button, hotkey from its settings, ScriptCat menu item) and its page-load trigger. Turning
 * it on selects the paragraphs (`select`: the site rule's blocks or auto, exclude, lazy viewport,
 * watch mutations), translates them batch by batch through the shared invoker (its cache applies)
 * and inserts each translation after its paragraph. Running it again (`toggle`) restores the page.
 * Not automation (R3.5): no consent, and the site pause does not apply.
 */
import { renderTemplate, type Position, type Scope } from "../../core/expr";
import { POSITIONS } from "../../core/rules/positions";
import type { CallStep, CommandTrigger, EntryDef, Resolved, ResolvedEntry, ResolvedFeature, TriggerDef } from "../../core/rules/types";
import { createSettingsStore, type Storage } from "../../core/stores";
import type { Command, RuntimeContext } from "../../shell";
import { afterLoad } from "../automation/triggers";
import { isEnabled } from "../page/enabled";
import { entryMatch, matchesAny } from "../selection/match";
import { invokerFor } from "../selection/services";
import { settingsOf, siteOf } from "../selection/triggers";
import { translateBlocks } from "./batch";
import { watchBlocks, type Block, type BlockOptions, type BlockWatcher, type WatchDeps } from "./blocks";
import { createInline, type Inline } from "./Inline";

/** The command's title while the page is in compare mode (mockup v6 网页对照·点小猫). */
export const RESTORE_TITLE = "恢复原文";
/** The cat's label while any compare is on. */
export const COMPARING = "对照中";

export interface CompareDeps extends WatchDeps {
  /** Stylesheet text for the inline translations (tests); defaults to the built one. */
  css?: string;
}

interface CompareEntry {
  feature: ResolvedFeature;
  entry: ResolvedEntry;
  call: CallStep;
}

/** The `call` step that translates the blocks. */
const callOf = (def: EntryDef): CallStep | undefined =>
  def.run.find((s): s is CallStep => "call" in s && s.batch === "blocks" && s.call === "translate");

/** Compare entries whose feature and entry match `url` and are switched on. */
export function compareEntries(resolved: Resolved, storage: Pick<Storage, "get">, url: string): CompareEntry[] {
  const out: CompareEntry[] = [];
  for (const feature of resolved.features) {
    if (!feature.enabled || !isEnabled(storage, feature.ref) || !matchesAny(feature.def.match, url) || matchesAny(feature.def.exclude, url)) continue;
    for (const entry of feature.entries) {
      if (!entry.enabled || !isEnabled(storage, entry.ref) || entry.def.present?.surface?.type !== "inline-after") continue;
      const call = callOf(entry.def);
      if (call && matchesAny(entryMatch(feature.def, entry.def), url)) out.push({ feature, entry, call });
    }
  }
  return out;
}

/** A broken expression gives `fallback`. */
async function render(value: unknown, scope: Scope, pos: Position, fallback: unknown): Promise<unknown> {
  try {
    return await renderTemplate(value, scope, pos);
  } catch {
    return fallback;
  }
}

const asBlocks = (v: unknown): BlockOptions["blocks"] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string") ? (v as string[]) : "auto";

interface Session {
  ctrl: AbortController;
  inline?: Inline;
  watcher?: BlockWatcher;
}

interface Spec {
  t: CompareEntry;
  trig: CommandTrigger;
  id: string;
  title: string;
  hotkey?: string;
}

const REWIRE_KEYS = ["cc:on:", "cc:set:"];

export function startCompare(ctx: RuntimeContext, deps: CompareDeps = {}): () => void {
  const { services, hostname } = ctx;
  const { storage } = services;
  const doc = ctx.root.host.ownerDocument;
  const win = doc.defaultView ?? window;
  const settings = createSettingsStore(storage);
  const invoker = invokerFor(services);

  const sessions = new Map<string, Session>();
  /** Page-load triggers that already ran (a rule or setting change does not run them again). */
  const loaded = new Set<string>();
  let list: CompareEntry[] = [];
  let specs: Spec[] = [];
  let registered: (() => void)[] = [];
  let unwire: (() => void)[] = [];
  let generation = 0;
  let awake = false;
  let disposed = false;

  const pageOf = () => ({ url: win.location.href, title: doc.title });
  const scopeOf = (t: CompareEntry) => {
    const page = pageOf();
    return { settings: settingsOf(settings, t.feature, t.entry, hostname), site: siteOf(services.rules.get(), t.entry.ref, page.url), page };
  };

  const hideSource = async (t: CompareEntry) =>
    (await render(t.entry.def.present?.surface.hideSource ?? false, { ...scopeOf(t), vars: {} }, POSITIONS.surface, false)) === true;

  /** The commands with their current titles (恢复原文 while on, for a toggling entry). */
  function publish() {
    for (const off of registered) off();
    registered = specs.map(({ t, trig, id, title, hotkey }) => {
      const cmd: Command = {
        id,
        title: sessions.has(t.entry.ref) && t.entry.def.toggle ? RESTORE_TITLE : title,
        ...(hotkey && { hotkey }),
        ...(trig.quick !== undefined && { quick: trig.quick }),
        run: () => toggle(t),
      };
      return ctx.commands.register(cmd);
    });
  }

  function changed() {
    const on = sessions.size > 0;
    // mockup v6 网页对照·进行中: the cat sleeps on with 对照中 next to it
    if (on) ctx.setAwake(false, COMPARING);
    else if (awake) ctx.setAwake(false);
    awake = on;
    if (!disposed) publish();
  }

  async function begin(t: CompareEntry) {
    const ref = t.entry.ref;
    const session: Session = { ctrl: new AbortController() };
    sessions.set(ref, session);
    changed();
    const { signal } = session.ctrl;
    const scope = scopeOf(t);
    const select = t.entry.def.select ?? {};
    const blocks = asBlocks(await render(select.blocks ?? "auto", scope, POSITIONS.select, "auto"));
    const runScope = { ...scope, vars: {} };
    const engines = await render(t.call.engines ?? [], runScope, POSITIONS.run, []);
    const to = await render((t.call.input as { to?: unknown } | undefined)?.to, runScope, POSITIONS.run, undefined);
    const only = await hideSource(t);
    if (signal.aborted) return;

    const first = [engines].flat().find((e): e is string => typeof e === "string" && e !== "");
    const engine = first ?? invoker.preferredEngines(t.call.call).using ?? "";
    const send = (bs: Block[]) =>
      void translateBlocks(
        bs,
        { engine, to: typeof to === "string" && to ? to : "zh-CN", signal, onBatch: (r) => session.inline?.show(r) },
        invoker,
      ).catch(() => {}); // aborted: the page is being restored
    session.inline = createInline({ openSettings: (to) => ctx.openSettings(to), onRetry: (_i, bs) => send(bs), only, css: deps.css });
    const watchDeps: WatchDeps = {
      ...(select.lazy === "viewport" ? deps.isVisible && { isVisible: deps.isVisible } : { isVisible: () => true }),
      ...(select.watch === "mutations" ? deps.observeMutations && { observeMutations: deps.observeMutations } : { observeMutations: () => () => {} }),
    };
    session.watcher = watchBlocks(
      doc.body ?? doc.documentElement,
      { blocks, exclude: select.exclude ?? [] },
      (bs) => {
        session.inline?.pending(bs);
        send(bs);
      },
      watchDeps,
    );
  }

  /** Abort batches still out, stop watching and give the page back as it was. */
  function end(ref: string, quiet = false) {
    const s = sessions.get(ref);
    if (!s) return;
    sessions.delete(ref);
    s.ctrl.abort();
    s.watcher?.stop();
    s.inline?.restore();
    if (!quiet) changed();
  }

  function toggle(t: CompareEntry) {
    if (disposed) return;
    const ref = t.entry.ref;
    if (sessions.has(ref)) {
      end(ref);
      if (t.entry.def.toggle) return;
    }
    void begin(t);
  }

  async function allows(trig: TriggerDef, t: CompareEntry) {
    return trig.enabled === undefined || (await render(trig.enabled, scopeOf(t), POSITIONS.trigger, false)) === true;
  }

  /** Stopped, or the shell is no longer on the page: nothing may start any more. */
  const gone = () => disposed || !ctx.root.host.isConnected;

  async function onLoad(t: CompareEntry, trig: TriggerDef) {
    if (gone() || sessions.has(t.entry.ref) || !(await allows(trig, t))) return;
    // still on and not started meanwhile
    if (!gone() && !sessions.has(t.entry.ref) && list.some((x) => x.entry.ref === t.entry.ref)) void begin(t);
  }

  async function wire() {
    const mine = ++generation;
    for (const off of unwire) off();
    unwire = [];
    // this wire's page-load waits; dropped if a newer wire or the stop overtakes it while it renders
    const waits: (() => void)[] = [];
    list = compareEntries(services.rules.get(), storage, pageOf().url);
    // switched off or gone from the rules: give the page back
    for (const ref of [...sessions.keys()]) if (!list.some((t) => t.entry.ref === ref)) end(ref);
    const next: Spec[] = [];
    for (const t of list) {
      for (const [i, trig] of t.entry.def.triggers.entries()) {
        const key = `${t.entry.ref}:${i}`;
        if (trig.on === "page-load" && !loaded.has(key)) {
          waits.push(
            afterLoad(win, () => {
              loaded.add(key);
              void onLoad(t, trig);
            }),
          );
        } else if (trig.on === "command") {
          const r = (await render({ title: trig.title, hotkey: trig.hotkey }, scopeOf(t), POSITIONS.trigger, {})) as { title?: unknown; hotkey?: unknown };
          next.push({
            t,
            trig,
            id: `compare:${t.entry.ref}:${i}`,
            title: typeof r.title === "string" ? r.title : trig.title,
            ...(typeof r.hotkey === "string" && r.hotkey && { hotkey: r.hotkey }),
          });
        }
      }
    }
    if (mine !== generation || disposed) {
      for (const off of waits) off();
      return;
    }
    unwire = waits;
    specs = next;
    publish();
  }

  /** 显示方式 applies to what is on the page now (R7.4). */
  async function applyShow() {
    for (const [ref, s] of sessions) {
      const t = list.find((x) => x.entry.ref === ref);
      if (!t || !s.inline) continue;
      const only = await hideSource(t);
      if (sessions.get(ref) === s) s.inline.setOnly(only);
    }
  }

  const unsubRules = services.rules.subscribe(() => void wire());
  const unsubStorage = storage.onChange((k) => {
    if (!REWIRE_KEYS.some((p) => k.startsWith(p))) return;
    void wire();
    if (k.startsWith("cc:set:")) void applyShow();
  });
  void wire();

  return () => {
    disposed = true;
    generation++;
    unsubRules();
    unsubStorage();
    for (const off of unwire) off();
    unwire = [];
    for (const off of registered) off();
    registered = [];
    for (const ref of [...sessions.keys()]) end(ref, true);
    changed();
  };
}
