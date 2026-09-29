// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { NavigationSection } from "../../appShell/navigationState";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings-general-panel sidebar", () => {
  it("shows every section with a per-section visibility checkbox", async () => {
    const panel = await mountPanel({ hiddenNavigationSections: ["workspaces"] });

    const toggles = sidebarToggles(panel);
    // Sessions come before checkouts: the sidebar lists what a user comes back
    // to first, and a session usually has a checkout of its own now.
    expect(toggles.map((toggle) => toggle.label)).toEqual([
      "Show Machines in sidebar",
      "Show Projects in sidebar",
      "Show Sessions in sidebar",
      "Show Workspaces in sidebar",
    ]);
    expect(toggles.map((toggle) => toggle.checked)).toEqual([true, true, true, false]);
  });

  it("toggles a section through the callback without a save button", async () => {
    const toggles: [string, boolean][] = [];
    const panel = await mountPanel({ hiddenNavigationSections: [] }, (section, hidden) => { toggles.push([section, hidden]); });

    const togglesAt = (index: number) => {
      const toggle = sidebarToggles(panel)[index];
      if (toggle === undefined) throw new Error(`Missing sidebar toggle ${String(index)}`);
      return toggle;
    };
    togglesAt(3).input.click();
    expect(toggles).toEqual([["workspaces", true]]);
    panel.hiddenNavigationSections = ["workspaces"];
    await panel.updateComplete;
    togglesAt(3).input.click();
    expect(toggles).toEqual([["workspaces", true], ["workspaces", false]]);
  });

  it("disables hiding the last visible section", async () => {
    const panel = await mountPanel({ hiddenNavigationSections: ["machines", "workspaces", "sessions"] });

    const toggles = sidebarToggles(panel);
    expect(toggles.map((toggle) => toggle.checked)).toEqual([false, true, false, false]);
    expect(toggles[1]?.input.disabled).toBe(true);
    expect(toggles[0]?.input.disabled).toBe(false);
  });
});

describe("settings-general-panel chat", () => {
  it("reflects browser-local transcript preferences and toggles them through the callbacks", async () => {
    const groupToggles: boolean[] = [];
    const thinkingToggles: boolean[] = [];
    const panel = new SettingsGeneralPanel();
    panel.configResponse = configResponse({ host: "127.0.0.1" });
    panel.eventGroupsExpandedByDefault = true;
    panel.thinkingPartsExpandedByDefault = false;
    panel.onToggleEventGroupsExpandedByDefault = (expanded) => { groupToggles.push(expanded); };
    panel.onToggleThinkingPartsExpandedByDefault = (expanded) => { thinkingToggles.push(expanded); };
    document.body.append(panel);
    await panel.updateComplete;

    const fields = [...(panel.shadowRoot?.querySelectorAll<HTMLLabelElement>('section[aria-label="Chat settings"] .toggle-field') ?? [])];
    expect(fields.map((field) => field.querySelector("span")?.textContent)).toEqual([
      "Open completed event groups by default",
      "Open thinking blocks by default",
    ]);
    const [groupInput, thinkingInput] = fields.map((field) => field.querySelector<HTMLInputElement>("input[type=checkbox]"));
    if (groupInput === null || groupInput === undefined || thinkingInput === null || thinkingInput === undefined) throw new Error("Missing chat events checkbox");
    expect(groupInput.checked).toBe(true);
    expect(thinkingInput.checked).toBe(false);

    groupInput.click();
    panel.eventGroupsExpandedByDefault = false;
    await panel.updateComplete;
    expect(groupInput.checked).toBe(false);
    expect(groupToggles).toEqual([false]);

    thinkingInput.click();
    panel.thinkingPartsExpandedByDefault = true;
    await panel.updateComplete;
    expect(thinkingInput.checked).toBe(true);
    expect(thinkingToggles).toEqual([true]);
  });
});

async function mountPanel(
  fixture: { hiddenNavigationSections: NavigationSection[] },
  onToggle?: (section: "machines" | "projects" | "workspaces" | "sessions", hidden: boolean) => void,
): Promise<SettingsGeneralPanel> {
  const panel = new SettingsGeneralPanel();
  panel.configResponse = configResponse({ host: "127.0.0.1" });
  panel.hiddenNavigationSections = fixture.hiddenNavigationSections;
  if (onToggle !== undefined) panel.onToggleNavigationSection = onToggle;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function sidebarToggles(panel: SettingsGeneralPanel): { input: HTMLInputElement; label: string; checked: boolean }[] {
  const fields = [...(panel.shadowRoot?.querySelectorAll<HTMLLabelElement>('section[aria-label="Sidebar settings"] .toggle-field') ?? [])];
  if (fields.length === 0) throw new Error("Missing sidebar visibility fields");
  return fields.map((field) => {
    const input = field.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (input === null) throw new Error("Missing sidebar visibility checkbox");
    return { input, label: field.querySelector("span")?.textContent ?? "", checked: input.checked };
  });
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
  };
}
