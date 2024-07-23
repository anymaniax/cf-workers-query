import { AsyncLocalStorage } from 'node:async_hooks';
import type { PlatformProxy } from 'wrangler';

export type ExecutionContext = PlatformProxy['ctx'];

const AsyncLocaleStorageContext = new AsyncLocalStorage<ExecutionContext>();

export const getCFExecutionContext = () => AsyncLocaleStorageContext.getStore();

export const defineCFExecutionContext = <
  T extends ExecutionContext,
  Func extends (...args: any) => any
>(
  context: T,
  func: Func
) => AsyncLocaleStorageContext.run(context, func);
