import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sessionsApi, type PiSettingsSnapshot, type PiSettingsUpdate, type SessionInfo } from "../api";
import "./ModalSurface";

const HTTP_TIMEOUT_OPTIONS = [
  { value: 30_000, label: "30 sec" },
  { value: 60_000, label: "1 min" },
  { value: 120_000, label: "2 min" },
  { value: 300_000, label: "5 min" },
  { value: 0, label: "Disabled" },
] as const;

@customElement("pi-settings-dialog")
export class PiSettingsDialog extends LitElement {
  @property({ attribute: false }) session: SessionInfo | undefined;
  @property() machineId = "local";
  @property() machineLabel = "local";
  @property({ attribute: false }) onClose?: () => void;
  @state() private snapshot: PiSettingsSnapshot | undefined;
  @state() private loading = true;
  @state() private pendingKey: PiSettingsUpdate["key"] | undefined;
  @state() private error = "";
  @state() private savedMessage = "";
  private requestSequence = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  override render(): TemplateResult {
    return html`
      <modal-surface
        .busy=${this.pendingKey !== undefined}
        .onClose=${() => this.onClose?.()}
        .initialFocus=${".settings-close"}
        label="Pi settings"
      >
        <header>
          <div>
            <span class="eyebrow">Pi</span>
            <h2>Settings</h2>
            <p>${this.targetLabel()}</p>
          </div>
          <button class="settings-close" aria-label="Close Pi settings" @click=${() => this.onClose?.()}>×</button>
        </header>
        <div class="content" aria-busy=${this.loading ? "true" : "false"}>
          ${this.error === "" ? nothing : html`<div class="notice error" role="alert">${this.error}</div>`}
          ${this.savedMessage === "" ? nothing : html`<div class="notice success" role="status">${this.savedMessage}</div>`}
          ${this.loading ? html`<div class="loading">Loading Pi settings…</div>` : this.renderSettings()}
        </div>
      </modal-surface>
    `;
  }

  private renderSettings(): TemplateResult {
    if (this.snapshot === undefined) return html`<div class="loading">Pi settings are unavailable.</div>`;
    const settings = this.snapshot;
    return html`
      <section class="group" aria-labelledby="runtime-settings-heading">
        <div class="group-heading">
          <h3 id="runtime-settings-heading">Current session</h3>
          <p>These values update the selected Pi session and its global defaults.</p>
        </div>
        ${this.renderToggle("autoCompact", "Auto-compact", "Automatically compact context when it gets too large", settings.autoCompact)}
        ${this.renderSelect("steeringMode", "Steering mode", "How steering messages are delivered while Pi is streaming", settings.steeringMode, [
          { value: "one-at-a-time", label: "One at a time" },
          { value: "all", label: "All queued messages" },
        ], "Delivery mode while streaming")}
        ${this.renderSelect("followUpMode", "Follow-up mode", "How follow-up messages are delivered while Pi is working", settings.followUpMode, [
          { value: "one-at-a-time", label: "One at a time" },
          { value: "all", label: "All queued messages" },
        ], "Delivery mode while working")}
        ${this.renderSelect("cacheWarming", "Cache warming", "Choose when Pi refreshes provider prompt caches", settings.cacheWarming, [
          { value: "off", label: "Off" },
          { value: "streaming", label: "While streaming" },
          { value: "idle", label: "While idle" },
        ], "Cache warming mode")}
      </section>

      <section class="group" aria-labelledby="network-settings-heading">
        <div class="group-heading">
          <h3 id="network-settings-heading">Model requests</h3>
          <p>Provider and timeout defaults are saved in Pi’s global settings.</p>
        </div>
        ${this.renderSelect("transport", "Transport", "Preferred transport for providers that support multiple transports", settings.transport, [
          { value: "auto", label: "Automatic" },
          { value: "sse", label: "SSE" },
          { value: "websocket", label: "WebSocket" },
          { value: "websocket-cached", label: "WebSocket (cached)" },
        ], "Provider transport")}
        ${this.renderHttpTimeout(settings.httpIdleTimeoutMs)}
        ${this.renderToggle("showCacheMissNotices", "Cache miss notices", "Show Pi notices for cache costs and provider recovery diagnostics", settings.showCacheMissNotices)}
      </section>

      <section class="group" aria-labelledby="trust-warning-settings-heading">
        <div class="group-heading">
          <h3 id="trust-warning-settings-heading">Trust and warnings</h3>
          <p>Security and diagnostic behavior for this machine’s active Pi profile.</p>
        </div>
        ${this.renderSelect("defaultProjectTrust", "Default project trust", "Fallback when no extension or saved trust decision applies", settings.defaultProjectTrust, [
          { value: "ask", label: "Ask in interactive Pi" },
          { value: "always", label: "Always trust" },
          { value: "never", label: "Never trust" },
        ], "Default project trust")}
        ${this.renderToggle("anthropicExtraUsageWarning", "Anthropic extra usage warning", "Warn when Anthropic subscription authentication may use paid extra usage", settings.anthropicExtraUsageWarning)}
      </section>
    `;
  }

  private renderToggle(key: "autoCompact" | "showCacheMissNotices" | "anthropicExtraUsageWarning", label: string, description: string, checked: boolean): TemplateResult {
    const disabled = this.disabled(key);
    return html`
      <label class="setting toggle">
        <span><strong>${label}</strong><small>${description}</small>${this.projectOverrideReason(key)}</span>
        <input type="checkbox" .checked=${checked} ?disabled=${disabled} aria-label=${label} @change=${(event: Event) => { this.updateToggle(key, event); }} />
      </label>
    `;
  }

  private renderSelect(key: "steeringMode" | "followUpMode" | "cacheWarming" | "transport" | "defaultProjectTrust", label: string, description: string, value: string, options: readonly { value: string; label: string }[], selectLabel: string): TemplateResult {
    const disabled = this.disabled(key);
    return html`
      <label class="setting">
        <span><strong>${label}</strong><small>${description}</small>${this.projectOverrideReason(key)}</span>
        <select aria-label=${selectLabel} ?disabled=${disabled} .value=${value} @change=${(event: Event) => { this.updateSelect(key, event); }}>
          ${options.map((option) => html`<option value=${option.value}>${option.label}</option>`)}
        </select>
      </label>
    `;
  }

  private renderHttpTimeout(value: number): TemplateResult {
    const key = "httpIdleTimeoutMs" as const;
    const disabled = this.disabled(key);
    const options = HTTP_TIMEOUT_OPTIONS.some((option) => option.value === value) ? HTTP_TIMEOUT_OPTIONS : [{ value, label: `${String(value / 1000)} sec` }, ...HTTP_TIMEOUT_OPTIONS];
    return html`
      <label class="setting">
        <span><strong>HTTP idle timeout</strong><small>Maximum idle gap while waiting for provider response data</small>${this.projectOverrideReason(key)}<em class="restart-note">Takes effect after the session daemon restarts.</em></span>
        <select aria-label="HTTP idle timeout" ?disabled=${disabled} .value=${String(value)} @change=${(event: Event) => { this.updateHttpTimeout(event); }}>
          ${options.map((option) => html`<option value=${String(option.value)}>${option.label}</option>`)}
        </select>
      </label>
    `;
  }

  private disabled(key: PiSettingsUpdate["key"]): boolean {
    return this.pendingKey !== undefined || this.snapshot?.projectOverrides.includes(key) === true;
  }

  private projectOverrideReason(key: PiSettingsUpdate["key"]): TemplateResult | typeof nothing {
    if (this.snapshot?.projectOverrides.includes(key) !== true) return nothing;
    return html`<em class="project-note">Controlled by this workspace’s .pi/settings.json.</em>`;
  }

  private targetLabel(): string {
    const cwd = this.session?.cwd ?? "the selected workspace";
    return `${this.machineLabel} · ${cwd}`;
  }

  private async load(): Promise<void> {
    const sequence = ++this.requestSequence;
    if (this.session === undefined) {
      this.loading = false;
      this.error = "No Pi session is selected.";
      return;
    }
    this.loading = true;
    this.error = "";
    try {
      const snapshot = await sessionsApi.piSettings(this.session, this.machineId);
      if (sequence === this.requestSequence) this.snapshot = snapshot;
    } catch (error) {
      if (sequence === this.requestSequence) this.error = `Failed to load Pi settings: ${errorMessage(error)}`;
    } finally {
      if (sequence === this.requestSequence) this.loading = false;
    }
  }

  private updateToggle(key: "autoCompact" | "showCacheMissNotices" | "anthropicExtraUsageWarning", event: Event): void {
    void this.updateSetting({ key, value: inputChecked(event) });
  }

  private updateSelect(key: "steeringMode" | "followUpMode" | "cacheWarming" | "transport" | "defaultProjectTrust", event: Event): void {
    const value = selectValue(event);
    if (key === "steeringMode" || key === "followUpMode") {
      void this.updateSetting({ key, value: value === "all" ? "all" : "one-at-a-time" });
    } else if (key === "cacheWarming") {
      void this.updateSetting({ key, value: value === "off" ? "off" : value === "idle" ? "idle" : "streaming" });
    } else if (key === "transport") {
      void this.updateSetting({ key, value: value === "sse" ? "sse" : value === "websocket" ? "websocket" : value === "websocket-cached" ? "websocket-cached" : "auto" });
    } else {
      void this.updateSetting({ key, value: value === "always" ? "always" : value === "never" ? "never" : "ask" });
    }
  }

  private updateHttpTimeout(event: Event): void {
    const value = Number(selectValue(event));
    if (Number.isSafeInteger(value) && value >= 0) void this.updateSetting({ key: "httpIdleTimeoutMs", value });
  }

  private async updateSetting(update: PiSettingsUpdate): Promise<void> {
    if (this.session === undefined || this.pendingKey !== undefined) return;
    const key = update.key;
    this.pendingKey = key;
    this.error = "";
    this.savedMessage = "";
    try {
      const snapshot = await sessionsApi.setPiSetting(this.session, update, this.machineId);
      this.snapshot = snapshot;
      this.savedMessage = key === "httpIdleTimeoutMs" ? "Saved. Restart the session daemon to apply the new timeout." : "Saved Pi setting.";
    } catch (error) {
      this.error = `Failed to save Pi setting: ${errorMessage(error)}`;
    } finally {
      this.pendingKey = undefined;
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 11; color: var(--pi-text); font: 14px/1.45 system-ui, sans-serif; }
    modal-surface { --modal-surface-width: min(760px, calc(100vw - 32px)); --modal-surface-max-height: min(760px, calc(100% - 32px)); }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--pi-border); }
    h2, h3, p { margin: 0; }
    h2 { margin-top: 2px; font-size: 22px; }
    h3 { font-size: 16px; }
    header p, .group-heading p, small, em { color: var(--pi-muted); }
    header p { margin-top: 4px; font-size: 12px; overflow-wrap: anywhere; }
    .eyebrow { color: var(--pi-accent); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    button { min-width: 40px; min-height: 40px; border: 0; border-radius: 8px; background: transparent; color: var(--pi-muted); font-size: 24px; cursor: pointer; }
    button:hover, button:focus-visible { background: var(--pi-selection-bg); color: var(--pi-text); }
    .content { min-height: 180px; overflow: auto; padding: 18px 20px 24px; }
    .group { display: grid; gap: 10px; }
    .group + .group { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--pi-border-muted); }
    .group-heading { margin-bottom: 2px; }
    .group-heading p { margin-top: 4px; font-size: 12px; }
    .setting { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 210px); align-items: center; gap: 20px; padding: 13px 14px; border: 1px solid var(--pi-border-muted); border-radius: 10px; background: var(--pi-surface); }
    .setting > span { min-width: 0; }
    small, em { display: block; margin-top: 3px; font-size: 12px; font-style: normal; }
    .restart-note { color: var(--pi-warning, #c58a00); }
    select { width: 100%; min-height: 40px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 7px 9px; font: inherit; }
    select:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    input[type="checkbox"] { justify-self: end; width: 22px; height: 22px; accent-color: var(--pi-accent); cursor: pointer; }
    .setting:has(input:disabled), .setting:has(select:disabled) { opacity: .72; }
    input:disabled, select:disabled { cursor: not-allowed; }
    .notice { margin-bottom: 12px; border: 1px solid var(--pi-border); border-radius: 9px; padding: 10px 12px; }
    .notice.error { border-color: var(--pi-danger); background: var(--pi-danger-bg, color-mix(in srgb, var(--pi-danger) 10%, transparent)); }
    .notice.success { border-color: var(--pi-success); background: var(--pi-success-bg, color-mix(in srgb, var(--pi-success) 10%, transparent)); }
    .loading { padding: 36px 12px; color: var(--pi-muted); text-align: center; }
    @media (max-width: 600px) {
      modal-surface { --modal-surface-width: 100%; --modal-surface-max-height: 100%; }
      header, .content { padding-left: 14px; padding-right: 14px; }
      .setting { grid-template-columns: 1fr; gap: 10px; }
      input[type="checkbox"] { justify-self: start; }
      select { max-width: none; }
    }
  `;
}

function inputChecked(event: Event): boolean {
  return event.currentTarget instanceof HTMLInputElement && event.currentTarget.checked;
}

function selectValue(event: Event): string {
  return event.currentTarget instanceof HTMLSelectElement ? event.currentTarget.value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
