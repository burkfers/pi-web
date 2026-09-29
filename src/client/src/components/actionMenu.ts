const ACTION_MENU_GAP_PX = 0;
const ACTION_MENU_MIN_USEFUL_HEIGHT_PX = 120;

interface ActionMenuRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ActionMenuPanelStyleOptions {
  constrainTo?: "host" | "viewport";
  /**
   * Edge the panel's start aligns to. A menu is right-aligned to its trigger;
   * a wider anchored panel reads better starting at the trigger's left edge.
   */
  align?: "end" | "start";
  /**
   * Panel width floor. A menu sizes to its trigger; a form needs a usable
   * width even when its trigger is a narrow sidebar button.
   */
  minWidth?: number;
}

export function actionMenuPanelStyle(target: EventTarget | null, options: ActionMenuPanelStyleOptions = {}): string {
  if (typeof HTMLElement === "undefined" || typeof window === "undefined" || !(target instanceof HTMLElement)) return "";
  const trigger = target.getBoundingClientRect();
  const bounds = options.constrainTo === "viewport" ? viewportBounds() : actionMenuBounds(target);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const leftBound = Math.max(0, bounds.left);
  const rightBound = Math.min(viewportWidth, bounds.right);
  const topBound = Math.max(0, bounds.top);
  const bottomBound = Math.min(viewportHeight, bounds.bottom);
  const triggerRight = Math.min(trigger.right, rightBound);
  const availableBelow = bottomBound - trigger.bottom - ACTION_MENU_GAP_PX;
  const availableAbove = trigger.top - topBound - ACTION_MENU_GAP_PX;
  const placement = availableBelow < ACTION_MENU_MIN_USEFUL_HEIGHT_PX && availableAbove > availableBelow
    ? [`bottom: ${px(viewportHeight - trigger.top + ACTION_MENU_GAP_PX)};`, `max-height: ${px(Math.max(0, availableAbove))};`]
    : [`top: ${px(trigger.bottom + ACTION_MENU_GAP_PX)};`, `max-height: ${px(Math.max(0, availableBelow))};`];

  // A start-aligned panel hangs off the trigger's left edge at its own width,
  // and slides to the viewport's right edge only when that would overflow.
  const panelRight = options.align === "start" && options.minWidth !== undefined
    ? (Math.max(0, trigger.left) + options.minWidth <= viewportWidth
      ? Math.max(0, trigger.left) + options.minWidth
      : viewportWidth)
    : triggerRight;
  const anchoredWidth = options.align === "start" && options.minWidth !== undefined
    ? options.minWidth
    : Math.max(0, triggerRight - leftBound);

  return [
    ...placement,
    `right: ${px(Math.max(0, viewportWidth - panelRight))};`,
    `max-width: ${px(Math.max(0, Math.min(anchoredWidth, rightBound - leftBound)))};`,
  ].join(" ");
}

function actionMenuBounds(target: HTMLElement): ActionMenuRect {
  const root = target.getRootNode();
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && root.host instanceof HTMLElement) return root.host.getBoundingClientRect();
  return viewportBounds();
}

function viewportBounds(): ActionMenuRect {
  return { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
}

function px(value: number): string {
  return `${String(Math.round(value))}px`;
}
