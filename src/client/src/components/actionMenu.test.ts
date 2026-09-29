import { afterEach, describe, expect, it, vi } from "vitest";
import { actionMenuPanelStyle } from "./actionMenu";

describe("actionMenuPanelStyle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("can constrain menus to the viewport for compact shadow-root controls", () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    const target = new FakeHTMLElement({ top: 10, right: 390, bottom: 46, left: 354 });

    expect(actionMenuPanelStyle(target, { constrainTo: "viewport" })).toBe("top: 46px; max-height: 754px; right: 10px; max-width: 390px;");
  });

  it("gives a start-aligned panel the anchor's left edge and a usable width", () => {
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    // A narrow sidebar button: the panel must not inherit that width.
    const trigger = new FakeHTMLElement({ top: 100, right: 300, bottom: 130, left: 8 });

    expect(actionMenuPanelStyle(trigger, { constrainTo: "viewport", align: "start", minWidth: 520 }))
      .toBe("top: 130px; max-height: 670px; right: 672px; max-width: 520px;");
  });

  it("keeps a start-aligned panel inside the viewport when the anchor is at the right edge", () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    const trigger = new FakeHTMLElement({ top: 10, right: 390, bottom: 46, left: 354 });

    // Slides left to the viewport edge rather than overflowing it.
    expect(actionMenuPanelStyle(trigger, { constrainTo: "viewport", align: "start", minWidth: 520 }))
      .toBe("top: 46px; max-height: 754px; right: 0px; max-width: 400px;");
  });
});

class FakeHTMLElement extends EventTarget {
  constructor(private readonly rect: { top: number; right: number; bottom: number; left: number }) {
    super();
  }

  getBoundingClientRect(): { top: number; right: number; bottom: number; left: number } {
    return this.rect;
  }
}
