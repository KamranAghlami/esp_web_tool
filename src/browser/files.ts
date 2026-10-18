import { FetchError, type FileHost, type LocalFile, type LocalFolder } from '../flash/host';

/** The File System Access API pickers (Chromium); not in TypeScript's DOM types yet. */
interface PickerWindow {
  showOpenFilePicker?(opts: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?(opts: {
    mode?: 'read';
    startIn?: FileSystemHandle;
  }): Promise<FileSystemDirectoryHandle>;
}

const win = window as unknown as PickerWindow;

const fromHandle = (handle: FileSystemFileHandle): LocalFile => ({
  name: handle.name,
  handle,
  read: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
});

const fromFile = (file: File): LocalFile => ({
  name: file.name,
  read: async () => new Uint8Array(await file.arrayBuffer()),
});

/** `<input type=file>` fallback; resolves [] if the dialog is cancelled. */
function inputPicker(multiple: boolean, accept: string): Promise<LocalFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.addEventListener('change', () => resolve([...(input.files ?? [])].map(fromFile)));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

function folderOf(dir: FileSystemDirectoryHandle): LocalFolder {
  return {
    name: dir.name,
    async read(path) {
      const segments = path.split('/').filter((s) => s && s !== '.');
      if (segments.includes('..')) throw new FetchError('paths outside the folder are not allowed');
      try {
        let d = dir;
        for (const s of segments.slice(0, -1)) d = await d.getDirectoryHandle(s);
        const file = await (await d.getFileHandle(segments.at(-1) ?? '')).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError')
          throw new FetchError(`not found in ${dir.name}/`);
        throw err;
      }
    },
  };
}

async function get(url: string, accept?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, accept ? { headers: { Accept: accept } } : undefined);
  } catch {
    // fetch() only says "Failed to fetch": no CORS header, offline or a bad host.
    throw new FetchError('blocked (no CORS) or unreachable');
  }
  if (res.ok) return res;
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0'
  ) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const at = reset ? ` until ${new Date(reset).toLocaleTimeString()}` : '';
    throw new FetchError(`rate limit reached${at}`);
  }
  throw new FetchError(res.status === 404 ? 'not found (404)' : `HTTP ${res.status}`);
}

export const browserFiles: FileHost = {
  // Both pickers are called synchronously, inside the caller's user gesture.
  pickFiles({ multiple, json }) {
    if (win.showOpenFilePicker) {
      return win
        .showOpenFilePicker({
          multiple,
          types: json
            ? [{ description: 'Flash manifest', accept: { 'application/json': ['.json'] } }]
            : [{ description: 'Firmware image', accept: { 'application/octet-stream': ['.bin'] } }],
        })
        .then(
          (handles) => handles.map(fromHandle),
          (err: unknown) => (isAbort(err) ? [] : Promise.reject(err)),
        );
    }
    return inputPicker(multiple, json ? '.json,application/json' : '.bin');
  },

  pickFolder(startIn) {
    if (!win.showDirectoryPicker)
      return Promise.reject(new FetchError('folder access needs Chrome or Edge'));
    const handle = startIn?.handle as FileSystemHandle | undefined;
    return win
      .showDirectoryPicker({ mode: 'read', ...(handle ? { startIn: handle } : {}) })
      .then(folderOf, (err: unknown) => (isAbort(err) ? null : Promise.reject(err)));
  },

  async fetchBytes(url) {
    return new Uint8Array(await (await get(url)).arrayBuffer());
  },

  async fetchJson(url) {
    return (await get(url, 'application/vnd.github+json')).json();
  },
};
