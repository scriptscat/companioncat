// 网页对照的段落选取：纯 DOM 逻辑，可见性检查和变动观察都可注入（jsdom 没有布局）。

export interface Block {
  el: Element;
  text: string;
}

export interface BlockOptions {
  /** 网站规则的选择器列表；`"auto"` 自动识别正文段落。 */
  blocks: string[] | "auto";
  /** 跳过这些元素以及它们里面的一切。 */
  exclude?: string[];
  /** 少于这么多字符的块忽略，默认 3。 */
  minChars?: number;
}

export interface WatchDeps {
  isVisible?: (el: Element) => boolean;
  /** 观察 root 下的新增内容，返回断开函数。 */
  observeMutations?: (root: Node, onChange: () => void) => () => void;
}

export interface BlockWatcher {
  stop(): void;
}

const AUTO_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, figcaption, td, th";
// 输入框、可编辑区域、陪伴猫自己的界面，永远不翻译
const ALWAYS_SKIP =
  "input, textarea, select, script, style, noscript, companion-cat, [contenteditable]:not([contenteditable=false i])";
const VIEWPORT_MARGIN = 300;
const DEFAULT_MIN_CHARS = 3;

const normalize = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function safeClosest(el: Element, selector: string): boolean {
  try {
    return el.closest(selector) !== null;
  } catch {
    return false;
  }
}

function validSelectors(list: string[] | undefined): string[] {
  return (list ?? []).filter((s) => {
    try {
      document.createDocumentFragment().querySelector(s);
      return true;
    } catch {
      return false;
    }
  });
}

export function selectBlocks(root: ParentNode, opts: BlockOptions): Block[] {
  const auto = opts.blocks === "auto";
  const skip = [ALWAYS_SKIP, ...validSelectors(opts.exclude)].join(", ");
  const min = opts.minChars ?? DEFAULT_MIN_CHARS;

  const set = new Set<Element>();
  for (const sel of auto ? [AUTO_SELECTOR] : opts.blocks) {
    for (const el of safeQueryAll(root, sel)) set.add(el);
  }
  // 文档顺序
  const candidates = Array.from(set)
    .filter((el) => !safeClosest(el, skip))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  // 自动识别取最内层（blockquote 里取 p）；站点规则取最外层（作者指定的就是整块）。
  // 沿祖先链查，长页面上也只是「段落数 × 层数」，不是两两比较。
  const inSet = new Set(candidates);
  const hasInner = new Set<Element>();
  if (auto) for (const el of candidates) for (let p = el.parentElement; p; p = p.parentElement) if (inSet.has(p)) hasInner.add(p);
  const hasOuter = (el: Element) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (inSet.has(p)) return true;
    return false;
  };
  const kept = candidates.filter((el) => (auto ? !hasInner.has(el) : !hasOuter(el)));

  const blocks: Block[] = [];
  for (const el of kept) {
    const text = normalize(el.textContent);
    if (text.length < min || !/\p{L}/u.test(text)) continue;
    blocks.push({ el, text });
  }
  return blocks;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  // display:none（折叠的菜单、隐藏的标签页）：一个空框，不算看得见
  if (r.width === 0 && r.height === 0) return false;
  return r.bottom >= -VIEWPORT_MARGIN && r.top <= window.innerHeight + VIEWPORT_MARGIN;
}

function observeDomMutations(root: Node, onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  return () => mo.disconnect();
}

/** 只交出进入视口的块；页面滚动或新增内容时，交出新进入视口的块，每个块只交一次。 */
export function watchBlocks(
  root: ParentNode & Node,
  opts: BlockOptions,
  onBlocks: (blocks: Block[]) => void,
  deps: WatchDeps = {},
): BlockWatcher {
  const isVisible = deps.isVisible ?? inViewport;
  const seen = new WeakSet<Element>();
  let stopped = false;

  const scan = () => {
    if (stopped) return;
    const fresh = selectBlocks(root, opts).filter((b) => !seen.has(b.el) && isVisible(b.el));
    if (fresh.length === 0) return;
    for (const b of fresh) seen.add(b.el);
    onBlocks(fresh);
  };

  const disconnect = (deps.observeMutations ?? observeDomMutations)(root, scan);
  // 捕获阶段：页面里内层滚动容器的 scroll 也能收到
  window.addEventListener("scroll", scan, { capture: true, passive: true });
  window.addEventListener("resize", scan, { passive: true });
  scan();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      disconnect();
      window.removeEventListener("scroll", scan, { capture: true });
      window.removeEventListener("resize", scan);
    },
  };
}
