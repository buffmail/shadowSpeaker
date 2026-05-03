export const opfsWrite = async (
  project: string,
  fileName: string,
  blob: Blob
) => {
  const root = await navigator.storage.getDirectory();

  const folder = await root.getDirectoryHandle(project, { create: true });
  const opfsFileHandle = await folder.getFileHandle(fileName, { create: true });
  const writable = await opfsFileHandle.createWritable();

  await writable.write(blob);
  await writable.close();
};

export const opfsRead = async (project: string, fileName: string) => {
  const root = await navigator.storage.getDirectory();

  const folder = await root.getDirectoryHandle(project);
  const opfsFileHandle = await folder.getFileHandle(fileName);
  const ab = (await opfsFileHandle.getFile()).arrayBuffer();
  return ab;
};

export const opfsDelete = async (project: string, fileName: string) => {
  if (project === "") {
    return;
  }
  const root = await navigator.storage.getDirectory();
  try {
    const folder = await root.getDirectoryHandle(project);
    await folder.removeEntry(fileName);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return;
    }
    throw err;
  }
};

interface IterableFileSystemDirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

export const opfsListProjects = async (): Promise<string[]> => {
  const root =
    (await navigator.storage.getDirectory()) as IterableFileSystemDirectoryHandle;
  const names: string[] = [];
  for await (const handle of root.values()) {
    if (handle.kind === "directory") {
      names.push(handle.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
};

export const opfsExist = async (project: string, filename: string) => {
  if (project === "") {
    return false;
  }
  const root = await navigator.storage.getDirectory();
  try {
    const folder = await root.getDirectoryHandle(project);
    await folder.getFileHandle(filename, { create: false });
    return true;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return false;
    } else {
      throw err;
    }
  }
};
