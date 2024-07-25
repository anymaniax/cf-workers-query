import { AsyncLocalStorage } from 'node:async_hooks';

export type ExecutionContext = {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
};

const AsyncLocaleStorageContext = new AsyncLocalStorage<ExecutionContext>();

export const getCFExecutionContext = () => AsyncLocaleStorageContext.getStore();

export const defineCFExecutionContext = <
  T extends ExecutionContext,
  Func extends (...args: any) => any
>(
  context: T,
  func: Func
) => AsyncLocaleStorageContext.run(context, func);
