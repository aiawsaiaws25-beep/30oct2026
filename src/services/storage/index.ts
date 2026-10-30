import { LocalStorageProvider } from "./local";
import type { StorageProvider } from "./types";

export type { StorageProvider } from "./types";

export function getStorageProvider(): StorageProvider {
  const provider = process.env.STORAGE_PROVIDER;
  switch (provider) {
    case "local":
      return new LocalStorageProvider(process.env.UPLOADS_DIR ?? "uploads");
    default:
      throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
  }
}
