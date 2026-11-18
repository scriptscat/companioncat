// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { anchor, fitBox, type Box } from "./anchor";

const VIEW = { width: 400, height: 700 };
const ON: Box = { top: 300, left: 0, right: 100, bottom: 330 };

describe("fitBox", () => {
  it("keeps a node of the given size inside the viewport margins", () => {
    expect(fitBox(380, -10, 120, 30, VIEW, 8, ON)).toEqual({ left: 272, top: 8 });
    expect(fitBox(20, 690, 120, 30, VIEW, 8, ON)).toEqual({ left: 20, top: 662 });
  });
  it("leaves the top alone when the box it belongs to is scrolled out of the viewport", () => {
    expect(fitBox(380, -900, 120, 30, VIEW, 8, { top: -860, left: 0, right: 100, bottom: -830 })).toEqual({ left: 272, top: -900 });
    expect(fitBox(20, 1500, 120, 30, VIEW, 8, { top: 1540, left: 0, right: 100, bottom: 1570 })).toEqual({ left: 20, top: 1500 });
  });
  it("a node wider than the viewport starts at the left margin; a box half on screen still keeps it inside", () => {
    expect(fitBox(50, 300, 500, 30, VIEW, 8, ON).left).toBe(8);
    expect(fitBox(20, -200, 120, 30, VIEW, 8, { top: -400, left: 0, right: 100, bottom: 40 }).top).toBe(8);
  });
});

describe("anchor", () => {
  const rect = (top: number) => ({ top, left: 0, right: 10, bottom: top + 10, width: 10, height: 10, x: 0, y: top, toJSON() {} });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function setup(n: number) {
    const layer = document.createElement("div");
    document.body.append(layer);
    let top = 100;
    const els = Array.from({ length: n }, () => {
      const el = document.createElement("p");
      el.getBoundingClientRect = () => rect(top);
      document.body.append(el);
      return el;
    });
    return { layer, els, move: (t: number) => (top = t) };
  }

  it("on a scroll every mark is measured before any mark moves (no read/write interleaving)", () => {
    const { layer, els, move } = setup(2);
    const a = document.createElement("div");
    const b = document.createElement("div");
    const seen: string[] = [];
    anchor(layer, els[0]!, a, (r) => ({ top: r.top, left: 0 }));
    anchor(layer, els[1]!, b, (r) => {
      seen.push(a.style.top);
      return { top: r.top, left: 0 };
    });
    seen.length = 0;
    move(50);
    window.dispatchEvent(new Event("scroll"));
    expect(a.style.top).toBe("50px");
    expect(b.style.top).toBe("50px");
    expect(seen).toEqual(["100px"]);
  });

  it("a mark whose placement throws does not keep the others from following", () => {
    const { layer, els, move } = setup(2);
    const a = document.createElement("div");
    const b = document.createElement("div");
    let fail = false;
    anchor(layer, els[0]!, a, (r) => {
      if (fail) throw new Error("boom");
      return { top: r.top, left: 0 };
    });
    anchor(layer, els[1]!, b, (r) => ({ top: r.top, left: 0 }));
    fail = true;
    move(40);
    window.dispatchEvent(new Event("scroll"));
    expect(b.style.top).toBe("40px");
  });

  it("leaves no scroll or resize listener behind once every mark is gone", () => {
    window.dispatchEvent(new Event("scroll")); // marks of the tests before go away by themselves
    const add = vi.spyOn(window, "addEventListener");
    const off = vi.spyOn(window, "removeEventListener");
    const { layer, els } = setup(3);
    const marks = els.map((el) => anchor(layer, el, document.createElement("div"), (r) => ({ top: r.top, left: 0 })));
    marks[0]!.remove();
    els[1]!.remove();
    window.dispatchEvent(new Event("scroll")); // the second goes by itself: its element left
    marks[2]!.remove();
    const count = (spy: typeof add, type: string) => spy.mock.calls.filter((c) => c[0] === type).length;
    for (const type of ["scroll", "resize"]) expect(count(off, type), type).toBe(count(add, type));
    expect(layer.childElementCount).toBe(0);
  });
});
