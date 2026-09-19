/** Share in-flight state between channel and tool modules reloaded by the host. */
export function runtimeState<T>(name: string, create: () => T): T {
  const key = Symbol.for(`@inkbox/inkbox/runtime/${name}`);
  const shared = globalThis as typeof globalThis & { [key: symbol]: unknown };
  return (shared[key] ??= create()) as T;
}
