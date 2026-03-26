/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "wa-sqlite/src/examples/IDBBatchAtomicVFS.js" {
  export class IDBBatchAtomicVFS {
    constructor(name?: string, options?: {
      durability?: "default" | "strict" | "relaxed";
      purge?: "deferred" | "manual";
      purgeAtLeast?: number;
    });
  }
}
