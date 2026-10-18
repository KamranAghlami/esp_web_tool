/**
 * Injected before the app loads: fake File System Access pickers. Tests queue what the next
 * file picker returns in `window.__picks` (each entry: files as { name, text } or { name, size })
 * and set `window.__folder` for the folder picker. Like Chrome, they need a user gesture.
 */
export function installFakeFiles(): void {
  type Spec = { name: string; text?: string; size?: number };
  const w = window as unknown as {
    __picks: Spec[][];
    __folder: Spec[] | null;
    showOpenFilePicker: unknown;
    showDirectoryPicker: unknown;
  };
  w.__picks = [];
  w.__folder = null;
  const file = (s: Spec) => new File([s.text ?? new Uint8Array(s.size ?? 1).fill(0xe9)], s.name);
  const gesture = () => {
    if (!navigator.userActivation.isActive)
      throw new DOMException('Must be handling a user gesture', 'SecurityError');
  };
  w.showOpenFilePicker = async () => {
    gesture();
    const specs = w.__picks.shift();
    if (!specs?.length) throw new DOMException('The user aborted a request.', 'AbortError');
    return specs.map((s) => ({ name: s.name, getFile: async () => file(s) }));
  };
  w.showDirectoryPicker = async () => {
    gesture();
    const specs = w.__folder;
    if (!specs) throw new DOMException('The user aborted a request.', 'AbortError');
    return {
      name: 'fw',
      getDirectoryHandle: async () => {
        throw new DOMException('no subfolders', 'NotFoundError');
      },
      getFileHandle: async (name: string) => {
        const s = specs.find((x) => x.name === name);
        if (!s) throw new DOMException('missing', 'NotFoundError');
        return { name, getFile: async () => file(s) };
      },
    };
  };
}
