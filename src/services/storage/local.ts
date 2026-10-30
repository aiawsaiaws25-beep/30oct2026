import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { StorageProvider } from "./types";

/** Keeps files in a private folder. The app must check access before serving one. */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string, projectRoot: string = process.cwd()) {
    this.root = resolve(projectRoot, root);
    if (isInside(resolve(projectRoot, "public"), this.root)) {
      throw new Error("Uploads must not be stored inside the public folder");
    }
  }

  async save(key: string, data: Buffer) {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  read(key: string) {
    return readFile(this.pathFor(key));
  }

  async delete(key: string) {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string) {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(key: string) {
    const path = resolve(this.root, key);
    if (path === this.root || !isInside(this.root, path)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  }
}

function isInside(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
