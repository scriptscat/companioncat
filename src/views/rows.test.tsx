// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { elementHandle } from "../core/expr";
import { renderView, type ViewAction } from "./index";

const show = (node: unknown, scope: Record<string, unknown>, onAction: (a: ViewAction) => void = () => {}) =>
  render(<>{renderView(node as never, scope, onAction)}</>);

describe("rows and scrollTo (R5.5)", () => {
  it("a row with an action is a button; clicking scrolls to the handle's element and reports the action", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    el.scrollIntoView = vi.fn();
    const handle = elementHandle(el);
    const onAction = vi.fn();
    show(
      { type: "row", action: { scrollTo: "{{ vars.h }}" }, children: [{ type: "text", value: "第 1 题" }] },
      { vars: { h: handle } },
      onAction,
    );
    await userEvent.click(await screen.findByRole("button", { name: /第 1 题/ }));
    await waitFor(() => expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" }));
    expect(onAction).toHaveBeenCalledWith({ scrollTo: handle });
  });

  it("scrollTo to a detached or missing element does nothing and does not throw", async () => {
    const onAction = vi.fn();
    show({ type: "row", action: { scrollTo: "{{ vars.h }}" }, children: [{ type: "text", value: "x" }] }, { vars: { h: elementHandle(document.createElement("i")) } }, onAction);
    await userEvent.click(await screen.findByRole("button"));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
  });

  it("row style is rendered as data-style (below-threshold rows); a row without action is not a button", async () => {
    const { container } = show(
      { type: "row", style: "{{ vars.low ? 'below' : '' }}", children: [{ type: "text", value: "a" }] },
      { vars: { low: true } },
    );
    await waitFor(() => expect(container.querySelector("[data-part=row]")?.getAttribute("data-style")).toBe("below"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an empty engineName hides the label above a result-list item", async () => {
    const { container } = show(
      { type: "result-list", primary: "none", from: "{{ vars.rows }}", item: { ok: { type: "text", value: "ok" } } },
      { vars: { rows: [{ engine: "q1", engineName: "", state: "ok", output: 1 }] } },
    );
    await screen.findByText("ok");
    expect(container.querySelector("[data-part=result-item] > p")).toBeNull();
  });
});

describe("text format percent (R5.5)", () => {
  it("shows a 0–1 number as a whole percent; anything else is shown as it is", async () => {
    const { container } = show(
      { type: "row", children: ["{{ vars.a }}", "{{ vars.b }}", "{{ vars.c }}", "{{ vars.d }}"].map((value) => ({ type: "text", format: "percent", value })) },
      { vars: { a: 0.96, b: 0.615, c: "n/a", d: 1 } },
    );
    await waitFor(() => expect(Array.from(container.querySelectorAll("[data-part=text]")).map((t) => t.textContent)).toEqual(["96%", "62%", "n/a", "100%"]));
  });

  it("without format a number is shown as it is", async () => {
    const { container } = show({ type: "text", value: "{{ vars.a }}" }, { vars: { a: 0.96 } });
    await waitFor(() => expect(container.querySelector("[data-part=text]")?.textContent).toBe("0.96"));
  });
});
