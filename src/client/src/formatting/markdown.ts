import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import { marked, type Tokens } from "marked";
import { replaceLocalMarkdownImages } from "./markdownImages";
import { workspaceFilePreviewUrl } from "../api/urls";
import { resolveAppUrl } from "../appUrl";
import { workspaceMarkdownFilePath, type MarkdownWorkspaceContext } from "./workspaceLinks";

// "lib/common" covers ~36 popular languages (python, typescript, json, …) and
// TOML aliases the registered "ini" grammar. Three in-demand grammars ship in
// the package but not in common, so they are registered here explicitly.
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.code = ({ text, lang }: Tokens.Code): string => {
  const language = lang?.trim().split(/\s/u)[0]?.toLowerCase() ?? "";
  const highlighted = language === "" ? undefined : highlightCode(text, language);
  const classAttribute = lang === undefined || lang === "" ? "" : ` class="language-${escapeHtml(language)}"`;
  const body = highlighted ?? escapeHtml(text);
  return `<pre><code${classAttribute}>${body}\n</code></pre>\n`;
};

// highlight.js tokens are styled via --pi-* variables in shared.ts, so colors
// follow the active theme contribution; no library stylesheet is imported.
const MAX_HIGHLIGHTED_CODE_LENGTH = 50_000;

function highlightCode(code: string, language: string): string | undefined {
  // getLanguage resolves aliases too ("toml" aliases the ini grammar); listLanguages() does not.
  if (hljs.getLanguage(language) === undefined || code.length > MAX_HIGHLIGHTED_CODE_LENGTH) return undefined;
  try {
    return hljs.highlight(code, { language }).value;
  } catch {
    // highlight.js throws for pathologically nested grammars; plain code beats
    // a failed chat render.
    return undefined;
  }
}

const MAX_MARKDOWN_CACHE_ENTRIES = 300;
const markdownHtmlCache = new Map<string, string>();

export function toSafeMarkdownHtml(text: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string): string {
  // Only workspace links depend on the effective application base, not route/query changes.
  const key = JSON.stringify([text, workspace === undefined ? null : [
    workspace.machineId, workspace.projectId, workspace.workspaceId, workspace.root, resolveAppUrl(""), imageIntentKey,
  ]]);
  const cached = markdownHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, { async: false, breaks: true, gfm: true, renderer });
  const safeHtml = sanitizeHtml(html, workspace, imageIntentKey);
  markdownHtmlCache.set(key, safeHtml);
  if (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (oldest !== undefined) markdownHtmlCache.delete(oldest);
  }
  return safeHtml;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const TABLE_SCROLL_CLASS = "table-scroll";

function sanitizeHtml(html: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (workspace !== undefined) replaceLocalMarkdownImages(template.content, workspace, imageIntentKey);
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => { node.remove(); });
  template.content.querySelectorAll("*").forEach((element) => {
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    if (href !== null && workspace !== undefined) {
      const path = workspaceMarkdownFilePath(href, workspace);
      if (path !== undefined) {
        element.setAttribute("href", workspaceFilePreviewUrl(workspace.projectId, workspace.workspaceId, path, { machineId: workspace.machineId, download: true }));
        element.setAttribute("data-workspace-file", path);
      }
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", element.hasAttribute("data-workspace-file") ? "_self" : "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  });
  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
}

// Markdown tables stay at their natural width and scroll horizontally instead of
// being squeezed into the chat column, which is unreadable on narrow screens.
function wrapTablesInScrollRegions(root: DocumentFragment): void {
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains(TABLE_SCROLL_CLASS) === true) return;
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Table");
    wrapper.setAttribute("tabindex", "0");
    table.before(wrapper);
    wrapper.append(table);
  });
}

function isSafeUrl(url: string): boolean {
  if (url.startsWith("#") || url.startsWith("/")) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
