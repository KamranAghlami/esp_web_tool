/**
 * What the flash plan needs from the browser: file and folder pickers and fetch. The page
 * implements it in `src/browser/files.ts`; tests can pass fakes. Pickers need a user gesture,
 * so callers must invoke them synchronously from input dispatch (SPEC §3.1).
 */
export interface FileHost {
  /** Resolves with [] when the user cancels. */
  pickFiles(opts: { multiple: boolean; json?: boolean }): Promise<LocalFile[]>;
  /** A folder to read parts from; `startIn` opens the dialog next to that file. */
  pickFolder(startIn?: LocalFile): Promise<LocalFolder | null>;
  /** Throws FetchError with a short, readable reason. */
  fetchBytes(url: string): Promise<Uint8Array>;
  /** GitHub API GET; throws FetchError (rate limit included). */
  fetchJson(url: string): Promise<unknown>;
  /**
   * A file or folder again from a handle kept across reloads (null if it can't be used).
   * Reading it throws AccessError until the user allows it again (`requestAccess`).
   */
  restoreFile(handle: unknown): LocalFile | null;
  restoreFolder(handle: unknown): LocalFolder | null;
  /** Asks to read kept handles again; must run synchronously from input. */
  requestAccess(handles: unknown[]): Promise<void>;
  /** Offer `data` as a download named `name` (a dump, a log). Needs no gesture. */
  save(name: string, data: Uint8Array | string): void;
}

export interface LocalFile {
  name: string;
  read(): Promise<Uint8Array>;
  /**
   * Opaque browser handle (FileSystemFileHandle) when available: for `startIn`, and kept
   * across reloads so the file can be read again.
   */
  handle?: unknown;
}

export interface LocalFolder {
  name: string;
  /** `path` relative to the folder, `/`-separated; throws FetchError ("not found"). */
  read(path: string): Promise<Uint8Array>;
  /** Opaque FileSystemDirectoryHandle, kept across reloads. */
  handle?: unknown;
}

export class FetchError extends Error {}
/** A kept file or folder that the browser won't read until the user allows it again. */
export class AccessError extends FetchError {}
