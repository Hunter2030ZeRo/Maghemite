import { createEffect, createMemo, onCleanup } from "solid-js";
import type { Json } from "../../../modules-sdk/js/mod.ts";
import type { WorkspaceDocument } from "../workspace/model.ts";
import {
  createAttachments, releaseAttachmentUrl, retainAttachmentUrl,
} from "../workspace/attachments.ts";
import {
  headingSlug,
  renderMarkdown,
} from "../workspace/markdown.ts";
import "./Markdown.css";

type MarkdownProps = {
  readonly document: WorkspaceDocument;
  readonly documents: readonly { readonly id: string; readonly path: string }[];
  readonly open: (id: string) => void;
  readonly openFile?: (path: string, fragment?: string) => void | Promise<void>;
  readonly request?: (method: string, parameters: Json) => Promise<Json>;
  readonly openSymbol?: (path: string, fragment: string) => Promise<void>;
  readonly notify: (text: string) => void;
};

export function Markdown(props: MarkdownProps) {
  let article: HTMLElement | undefined;
  const html = createMemo(() =>
    renderMarkdown(props.document.content, {
      documentId: props.document.id,
      currentPath: props.document.path,
      documents: props.documents,
    })
  );
  const resources = new Map<
    HTMLImageElement,
    { readonly controller: AbortController; readonly url?: string }
  >();
  const downloads = new Set<AbortController>();
  let downloadUrl: string | undefined;
  let generation = 0;

  function releaseResources(): void {
    generation++;
    for (const resource of resources.values()) {
      resource.controller.abort();
      if (resource.url) releaseAttachmentUrl(resource.url);
    }
    resources.clear();
    for (const download of downloads) download.abort();
    if (downloadUrl) releaseAttachmentUrl(downloadUrl);
    downloadUrl = undefined;
  }

  function jump(
    fragment: string,
    root: HTMLElement | null | undefined = article,
  ): void {
    const slug = headingSlug(fragment);
    const heading = [...(root?.querySelectorAll<HTMLElement>("[data-heading-slug]") ?? [])]
      .find((element) => element.dataset.headingSlug === slug);
    heading?.scrollIntoView({ block: "start" });
  }

  function jumpAfterOpen(fragment: string): void {
    if (!fragment) return;
    queueMicrotask(() => {
      const active = document.querySelector<HTMLElement>(
        ".active-group .tab-surface:not([hidden]) .markdown",
      );
      jump(fragment, active);
    });
  }

  function openWorkspaceLink(path: string, fragment: string): void {
    if (fragment.startsWith("symbol:")) {
      if (!props.openSymbol) props.notify("Code symbol navigation is unavailable.");
      else void props.openSymbol(path, fragment).catch((error) => props.notify(String(error)));
      return;
    }
    if (path.split("/").some((part) => part.endsWith(".attachments"))) {
      void downloadAttachment(path);
      return;
    }
    if (path === props.document.path) {
      if (fragment) jump(fragment);
      return;
    }
    if (props.openFile) {
      void Promise.resolve(props.openFile(path, fragment || undefined)).then(
        () => jumpAfterOpen(fragment),
        (error) => props.notify(String(error)),
      );
      return;
    }
    const document = props.documents.find((item) => item.path === path);
    if (document) {
      props.open(document.id);
      jumpAfterOpen(fragment);
    }
    else props.notify(`No note named ${path} in this workspace`);
  }

  async function downloadAttachment(path: string) {
    if (!props.request) {
      props.notify("Open a desktop workspace to download attachments.");
      return;
    }
    const controller = new AbortController();
    downloads.add(controller);
    try {
      const blob = await createAttachments(props.request).download(path, controller.signal);
      if (controller.signal.aborted) return;
      if (downloadUrl) releaseAttachmentUrl(downloadUrl);
      downloadUrl = retainAttachmentUrl(blob, path);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = path.split("/").at(-1) ?? "attachment";
      anchor.click();
      props.notify(`Download started: ${anchor.download}`);
    } catch (error) {
      if (!controller.signal.aborted) props.notify(String(error));
    } finally {
      downloads.delete(controller);
    }
  }

  function activateLink(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a");
    if (!anchor || !article?.contains(anchor)) return;
    const path = anchor.dataset.workspaceLink;
    const fragment = anchor.dataset.noteFragment ?? "";
    if (path !== undefined) {
      event.preventDefault();
      openWorkspaceLink(path, fragment);
    } else if (anchor.hasAttribute("data-note-fragment")) {
      event.preventDefault();
      jump(fragment);
    }
  }

  async function loadImages(): Promise<void> {
    releaseResources();
    const current = generation;
    const images = article?.querySelectorAll<HTMLImageElement>(
      "img[data-attachment]",
    );
    if (!images?.length) return;
    if (!props.request) {
      for (const image of images) {
        image.replaceWith(blockedImage(
          `${image.alt || "Image"}: desktop workspace required`,
        ));
      }
      return;
    }
    const attachments = createAttachments(props.request);
    for (const image of images) {
      if (current !== generation) return;
      const path = image.dataset.attachment;
      if (!path) continue;
      const controller = new AbortController();
      resources.set(image, { controller });
      try {
        const blob = await attachments.read(path, controller.signal);
        if (controller.signal.aborted || !image.isConnected) continue;
        const url = retainAttachmentUrl(blob, path);
        resources.set(image, { controller, url });
        image.src = url;
        image.removeAttribute("data-attachment");
      } catch (error) {
        if (controller.signal.aborted) continue;
        resources.delete(image);
        image.replaceWith(blockedImage(
          `${image.alt || path}: ${String(error)}`,
        ));
      }
    }
  }

  function blockedImage(message: string): HTMLSpanElement {
    const element = document.createElement("span");
    element.className = "markdown-image-blocked";
    element.textContent = message;
    return element;
  }

  createEffect(() => {
    html();
    queueMicrotask(() => void loadImages());
  });
  onCleanup(releaseResources);

  return (
    <article
      ref={(element) => {
        article = element;
      }}
      class="markdown"
      aria-label="Note preview"
      onClick={activateLink}
      innerHTML={html()}
    />
  );
}
