/**
 * What the app sees of its terminal: a byte-ish stream in each direction plus a size.
 * The app never touches the DOM through this; see src/browser/ for the few things that must.
 */
export interface Tty {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  /** Raw input as the terminal would send it to a program's stdin. */
  onData(listener: (data: string) => void): Disposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable;
}

export interface Disposable {
  dispose(): void;
}
