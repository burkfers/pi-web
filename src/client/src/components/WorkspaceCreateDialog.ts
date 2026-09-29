import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { workspacesApi, type WorkspaceCreationPreview } from "../api";
import { actionMenuPanelStyle } from "./actionMenu";
import { deepActiveElement } from "./modalLayerRegistry";

/** Width the form needs to be usable, whatever width its trigger is. */
const PANEL_MIN_WIDTH_PX = 520;

/** How long to wait after the last edit before asking the host for a plan. */
const PREVIEW_DEBOUNCE_MS = 300;

export interface WorkspaceCreateRequest {
  name: string;
  baseRef: string;
  path?: string;
}

export interface WorkspaceCreateSubmission extends WorkspaceCreateRequest {
  preview: WorkspaceCreationPreview;
}

/**
 * Asks the host what creating a workspace would actually do before offering to
 * do it. The plan is the provider's — resolved path, label, confirmation text,
 * and exact command — so the user confirms the real operation rather than the
 * form they typed into.
 */
@customElement("workspace-create-dialog")
export class WorkspaceCreateDialog extends LitElement {
  @property({ attribute: false }) onSubmit?: (submission: WorkspaceCreateSubmission) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @property() machineId = "local";
  @property() projectId = "";
  @property() actionLabel = "New worktree";
  @property({ attribute: false }) defaultBaseRef: string | undefined = undefined;
  @property({ attribute: false }) preview: ((request: WorkspaceCreateRequest) => Promise<WorkspaceCreationPreview>) | undefined = undefined;
  @property({ attribute: false }) creating = false;
  /** Control this panel is anchored to, positioned like an anchored menu. */
  @property({ attribute: false }) anchor: HTMLElement | undefined = undefined;
  @property({ attribute: false }) open = false;

  @state() private name = "";
  @state() private baseRef = "";
  @state() private pathOverride = "";
  @state() private plan: WorkspaceCreationPreview | undefined;
  @state() private planError: string | undefined;
  @state() private resolving = false;
  @query("input") private firstInput?: HTMLInputElement;

  private previewTimer: number | undefined;
  private previewRequest = 0;
  private lastRequestedKey: string | undefined;
  private previouslyFocused: HTMLElement | undefined;
  private readonly onDocumentPointerDown = (event: Event): void => {
    // The composed path, not event.target: this listener sits on the document,
    // where a press inside the panel's or the trigger's shadow root arrives
    // retargeted to the outermost host, and every press would read as outside.
    const path = event.composedPath();
    if (path.includes(this)) return;
    if (this.anchor !== undefined && path.includes(this.anchor)) return;
    this.onCancel?.();
  };
  private readonly onEscapeKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.onCancel?.();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.baseRef = this.defaultBaseRef ?? "HEAD";
  }

  override disconnectedCallback(): void {
    this.clearPreviewTimer();
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.removeEventListener("keydown", this.onEscapeKey);
    super.disconnectedCallback();
    // Hand focus back where it came from, the way an anchored menu does.
    const previous = this.previouslyFocused;
    this.previouslyFocused = undefined;
    if (previous?.isConnected === true) previous.focus();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("open") || !this.open) return;
    const active = deepActiveElement(this.ownerDocument);
    this.previouslyFocused = active instanceof HTMLElement ? active : undefined;
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.addEventListener("keydown", this.onEscapeKey);
    // The host is the fixed box; its offsets come from the measured anchor.
    this.style.cssText = this.placement;
    this.firstInput?.focus();
  }

  /** Anchored placement, recomputed whenever the panel opens. */
  private get placement(): string {
    return this.anchor === undefined ? "" : actionMenuPanelStyle(this.anchor, {
      constrainTo: "viewport",
      align: "start",
      minWidth: PANEL_MIN_WIDTH_PX,
    });
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer === undefined) return;
    window.clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
  }

  private get request(): WorkspaceCreateRequest {
    const path = this.pathOverride.trim();
    return {
      name: this.name.trim(),
      baseRef: this.baseRef.trim(),
      ...(path === "" ? {} : { path }),
    };
  }

  private get requestKey(): string {
    const { name, baseRef, path } = this.request;
    return JSON.stringify([name, baseRef, path ?? null]);
  }

  /**
   * Re-plans on the trailing edge of typing, and only for a complete request.
   * Each edit supersedes the request before it, so a slow plan for stale input
   * can never overwrite the plan on screen.
   */
  private schedulePreview(): void {
    this.clearPreviewTimer();
    const key = this.requestKey;
    if (this.request.name === "" || this.request.baseRef === "") {
      this.previewRequest += 1;
      this.lastRequestedKey = undefined;
      this.plan = undefined;
      this.planError = undefined;
      this.resolving = false;
      return;
    }
    this.resolving = true;
    this.previewTimer = window.setTimeout(() => { void this.resolvePreview(key); }, PREVIEW_DEBOUNCE_MS);
  }

  private async resolvePreview(key: string): Promise<void> {
    const requestId = ++this.previewRequest;
    this.lastRequestedKey = key;
    const request = this.request;
    try {
      const plan = this.preview === undefined
        ? await workspacesApi.previewWorkspaceCreation(this.projectId, request, this.machineId)
        : await this.preview(request);
      if (requestId !== this.previewRequest || key !== this.requestKey) return;
      this.plan = plan;
      this.planError = undefined;
    } catch (error) {
      if (requestId !== this.previewRequest || key !== this.requestKey) return;
      this.plan = undefined;
      this.planError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === this.previewRequest) this.resolving = false;
    }
  }

  private submit(): void {
    const plan = this.plan;
    if (plan === undefined || this.creating) return;
    this.onSubmit?.({ ...this.request, preview: plan });
  }

  private renderPlan(): unknown {
    if (this.planError !== undefined) return html`<p class="error" role="alert">${this.planError}</p>`;
    if (this.plan === undefined) {
      return html`<p class="hint">${this.resolving ? "Resolving…" : "Enter a name to see what will be created."}</p>`;
    }
    return html`
      <pre class="plan">${this.plan.confirmation}</pre>
      <p class="path">${this.plan.path}</p>
    `;
  }

  override render() {
    const canCreate = this.plan !== undefined && !this.creating;
    return html`
      <section
        role="dialog"
        aria-label=${this.actionLabel}
        aria-busy=${this.creating ? "true" : "false"}
        tabindex="-1"
      >
        <header>
          <strong>${this.actionLabel}</strong>
          <button @click=${() => { this.onCancel?.(); }} aria-label="Close">×</button>
        </header>
        <div class="body">
          <label>
            Name
            <input
              .value=${this.name}
              @input=${(event: InputEvent) => { this.name = eventValue(event); this.schedulePreview(); }}
              placeholder="review"
              autocomplete="off"
            />
          </label>
          <label>
            Base ref
            <input
              .value=${this.baseRef}
              @input=${(event: InputEvent) => { this.baseRef = eventValue(event); this.schedulePreview(); }}
              placeholder="main"
              autocomplete="off"
            />
          </label>
          <details>
            <summary>Path</summary>
            <label>
              Leave empty to use the default beside this project
              <input
                .value=${this.pathOverride}
                @input=${(event: InputEvent) => { this.pathOverride = eventValue(event); this.schedulePreview(); }}
                placeholder="default"
                autocomplete="off"
              />
            </label>
          </details>
          ${this.renderPlan()}
        </div>
        <footer>
          <button @click=${() => { this.onCancel?.(); }} ?disabled=${this.creating}>Cancel</button>
          <button class="primary" ?disabled=${!canCreate} @click=${() => { this.submit(); }}>
            ${this.creating ? "Creating…" : this.actionLabel}
          </button>
        </footer>
      </section>
    `;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || this.plan === undefined || this.creating) return;
    event.preventDefault();
    this.submit();
  }

  static override styles = css`
    /* Fixed, so the panel is out of flow: it never reflows the surface it was
       opened from. Placement (top/right/max-*) is inline, measured from the
       anchor, and flips above the trigger when there is no room below. */
    /* The host is the measured box: placement caps its height to the room the
       anchor leaves. It is a flex container that clips, so the panel fills that
       box instead of painting past it, and the body scrolls inside it. */
    :host { position: fixed; z-index: 50; display: flex; overflow: hidden; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    section {
      box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;
      min-width: min(520px, calc(100vw - 16px)); min-height: 0; max-height: 100dvh;
      border: 1px solid var(--pi-border); border-radius: 10px;
      background: var(--pi-bg); box-shadow: 0 8px 24px var(--pi-shadow);
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; padding: 10px 12px; border-bottom: 1px solid var(--pi-border); }
    footer { display: flex; gap: 8px; justify-content: flex-end; flex: none; padding: 10px 12px; border-top: 1px solid var(--pi-border); }
    /* min-height:0 lets this flex item shrink below its content so it can
       scroll; without it the panel grows past the measured box and the bottom
       of the form is outside every scrollable area. */
    .body { display: flex; flex-direction: column; gap: 0.75rem; padding: 12px; min-height: 0; overflow: auto; overscroll-behavior: contain; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--pi-muted); }
    input {
      box-sizing: border-box; width: 100%; font: inherit; padding: 8px 9px; border-radius: 8px;
      border: 1px solid var(--pi-border); background: var(--pi-bg); color: var(--pi-text);
    }
    details summary { cursor: pointer; font-size: 12px; color: var(--pi-muted); }
    details label { margin-top: 0.5rem; }
    .hint { margin: 0; font-size: 12px; color: var(--pi-muted); }
    .error { margin: 0; font-size: 12px; color: var(--pi-danger, #e5534b); white-space: pre-wrap; }
    .plan {
      margin: 0; padding: 10px; border-radius: 8px; font-size: 12px; line-height: 1.4;
      white-space: pre-wrap; background: var(--pi-surface); border: 1px solid var(--pi-border);
    }
    .path { margin: 0; font-size: 12px; color: var(--pi-muted); word-break: break-all; }
  `;
}

function eventValue(event: InputEvent): string {
  const target: EventTarget | null = event.target;
  return target instanceof HTMLInputElement ? target.value : "";
}

declare global {
  interface HTMLElementTagNameMap {
    "workspace-create-dialog": WorkspaceCreateDialog;
  }
}
