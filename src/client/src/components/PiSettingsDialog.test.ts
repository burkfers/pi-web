// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { PiSettingsDialog } from "./PiSettingsDialog";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("pi-settings-dialog", () => {
  it("renders the web-relevant Pi settings and persists a changed value", async () => {
    const snapshot = piSettingsSnapshot();
    vi.spyOn(api.sessionsApi, "piSettings").mockResolvedValue(snapshot);
    const setPiSetting = vi.spyOn(api.sessionsApi, "setPiSetting").mockImplementation((_session, update) => Promise.resolve({ ...snapshot, ...update }));
    const dialog = new PiSettingsDialog();
    dialog.session = session();
    dialog.machineLabel = "Lab Mac";
    document.body.append(dialog);
    await settle(dialog);

    expect(dialog.renderRoot.textContent).toContain("Current session");
    expect(dialog.renderRoot.textContent).toContain("Model requests");
    expect(dialog.renderRoot.textContent).toContain("Trust and warnings");
    expect(selectControl(dialog, "Delivery mode while streaming").value).toBe("one-at-a-time");
    expect(checkboxControl(dialog, "Auto-compact").checked).toBe(true);

    const steering = selectControl(dialog, "Delivery mode while streaming");
    steering.value = "all";
    steering.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(dialog);

    expect(setPiSetting).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }), { key: "steeringMode", value: "all" }, "local");
    expect(dialog.renderRoot.querySelector('[role="status"]')?.textContent).toContain("Saved Pi setting");
  });

  it("disables settings controlled by the workspace project file", async () => {
    vi.spyOn(api.sessionsApi, "piSettings").mockResolvedValue({ ...piSettingsSnapshot(), projectOverrides: ["transport", "steeringMode"] });
    const dialog = new PiSettingsDialog();
    dialog.session = session();
    document.body.append(dialog);
    await settle(dialog);

    expect(selectControl(dialog, "Provider transport").disabled).toBe(true);
    expect(selectControl(dialog, "Delivery mode while streaming").disabled).toBe(true);
    expect(dialog.renderRoot.textContent).toContain("Controlled by this workspace’s .pi/settings.json");
  });
});

function session(): api.SessionInfo {
  return { id: "session-1", cwd: "/repo", path: "/tmp/session-1.jsonl", created: "now", modified: "now", messageCount: 0, firstMessage: "" };
}

function piSettingsSnapshot(): api.PiSettingsSnapshot {
  return { autoCompact: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", transport: "auto", cacheWarming: "streaming", httpIdleTimeoutMs: 300000, defaultProjectTrust: "ask", showCacheMissNotices: false, anthropicExtraUsageWarning: true, projectOverrides: [], restartRequired: ["httpIdleTimeoutMs"] };
}

async function settle(dialog: PiSettingsDialog): Promise<void> {
  await dialog.updateComplete;
  await dialog.updateComplete;
}

function selectControl(dialog: PiSettingsDialog, label: string): HTMLSelectElement {
  const element = dialog.renderRoot.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (element === null) throw new Error(`Missing select control: ${label}`);
  return element;
}

function checkboxControl(dialog: PiSettingsDialog, label: string): HTMLInputElement {
  const element = dialog.renderRoot.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`);
  if (element === null) throw new Error(`Missing checkbox control: ${label}`);
  return element;
}
