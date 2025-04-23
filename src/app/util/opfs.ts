export const opfsWrite = async (fileName: string, blob: Blob) => {
  const root = await navigator.storage.getDirectory();

  const opfsFileHandle = await root.getFileHandle(fileName, { create: true });
  const writable = await opfsFileHandle.createWritable();

  await writable.write(blob);
  await writable.close();
};

export const opfsRead = async (fileName: string) => {
  const root = await navigator.storage.getDirectory();

  const opfsFileHandle = await root.getFileHandle(fileName);
  const ab = (await opfsFileHandle.getFile()).arrayBuffer();
  return ab;
};

export const opfsExist = async (filename: string) => {
  const root = await navigator.storage.getDirectory();
  try {
    await root.getFileHandle(filename, { create: false });
    return true;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return false;
    } else {
      throw err;
    }
  }
};

export const opfsClearAll = async (ext: string | undefined) => {
  const root = await navigator.storage.getDirectory();

  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "file") {
      if (ext !== undefined && !name.endsWith(ext)) continue;
      await root.removeEntry(name);
    }
  }
};
