export const opfsWrite = async (
  project: string,
  fileName: string,
  blob: Blob
) => {
  const root = await navigator.storage.getDirectory();

  const folder = await root.getDirectoryHandle(project);
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

export const opfsExist = async (project: string, filename: string) => {
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
