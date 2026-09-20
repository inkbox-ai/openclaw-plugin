// The current host ships this runtime entry without its declaration file.
declare module "openclaw/plugin-sdk/file-lock" {
  export function withFileLock<T>(
    filePath: string,
    options: {
      stale: number;
      retries: {
        retries: number;
        factor: number;
        minTimeout: number;
        maxTimeout: number;
        randomize?: boolean;
      };
    },
    fn: () => Promise<T>,
  ): Promise<T>;
}
