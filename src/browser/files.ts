import {
  AccessError,
  FetchError,
  type FileHost,
  type LocalFile,
  type LocalFolder,
} from '../flash/host';

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

/** Permission methods of kept handles (Chromium); not in TypeScript's DOM types yet. */
interface PermissionHandle {
  queryPermission?(opts: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' }): Promise<PermissionState>;
}

const win = window as unknown as PickerWindow;

/** After a reload, kept handles throw NotAllowedError until the user allows them again. */
async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'SecurityError')
    )
      throw new AccessError('needs permission again');
    throw err;
  }
}

export const fromHandle = (handle: FileSystemFileHandle): LocalFile => ({
  name: handle.name,
  handle,
  read: () => guarded(async () => new Uint8Array(await (await handle.getFile()).arrayBuffer())),
});

const isHandle = (h: unknown, kind: FileSystemHandleKind): boolean =>
  typeof FileSystemHandle !== 'undefined' && h instanceof FileSystemHandle && h.kind === kind;

export const fromFile = (file: File): LocalFile => ({
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
    handle: dir,
    async read(path) {
      const segments = path.split('/').filter((s) => s && s !== '.');
      if (segments.includes('..')) throw new FetchError('paths outside the folder are not allowed');
      try {
        return await guarded(async () => {
          let d = dir;
          for (const s of segments.slice(0, -1)) d = await d.getDirectoryHandle(s);
          const file = await (await d.getFileHandle(segments.at(-1) ?? '')).getFile();
          return new Uint8Array(await file.arrayBuffer());
        });
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
    throw new FetchError('unreachable or no CORS');
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

  restoreFile(handle) {
    return isHandle(handle, 'file') ? fromHandle(handle as FileSystemFileHandle) : null;
  },

  restoreFolder(handle) {
    return isHandle(handle, 'directory') ? folderOf(handle as FileSystemDirectoryHandle) : null;
  },

  save(name, data) {
    const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  },

  async requestAccess(handles) {
    // All requested inside the same gesture; Chrome asks once per handle not yet allowed.
    await Promise.all(
      handles.map((h) => (h as PermissionHandle).requestPermission?.({ mode: 'read' })),
    );
  },
};
