import type { LocalFile } from '../flash/host';
import { fromFile, fromHandle } from './files';

interface HandleItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

/**
 * Files dragged onto the page (SPEC §3.1, §7.4 manual assist). Chrome gives file handles for
 * dropped files, so they can be kept across reloads like picked ones; otherwise plain Files.
 * `onDrag` says when something is being dragged over, for the "drop here" hint.
 */
export function attachDrop(
  el: HTMLElement,
  onFiles: (files: LocalFile[]) => void,
  onDrag: (over: boolean) => void,
): void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  el.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) onDrag(true);
  });
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    if (depth > 0 && --depth === 0) onDrag(false);
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    onDrag(false);
    const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
    // Handles must be asked for during the drop event itself.
    const handles = items.map((i) => (i as HandleItem).getAsFileSystemHandle?.() ?? null);
    const files = items.map((i) => i.getAsFile());
    void Promise.all(handles.map((h) => h?.catch(() => null) ?? null)).then((hs) => {
      const out: LocalFile[] = [];
      hs.forEach((h, i) => {
        if (h?.kind === 'file') out.push(fromHandle(h as FileSystemFileHandle));
        else if (files[i]) out.push(fromFile(files[i]));
      });
      if (out.length) onFiles(out);
    });
  });
}
