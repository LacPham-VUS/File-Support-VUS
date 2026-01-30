import { createStore, get, set, del, clear, entries } from 'idb-keyval';
import type { FileProcessingState } from '../models/appModels';

const store = createStore('pdf-processor-db', 'pdf-store');

const fileKey = (id: string) => `file-${id}`;
const stateKey = (id: string) => `state-${id}`;

export const saveFileData = async (id: string, dataUrl: string): Promise<void> => {
  await set(fileKey(id), dataUrl, store);
};

export const loadFileData = async (id: string): Promise<string | null> => {
  const data = await get<string | null>(fileKey(id), store);
  return data ?? null;
};

export const deleteFileData = async (id: string): Promise<void> => {
  await del(fileKey(id), store);
};

export const saveFileState = async (id: string, state: FileProcessingState): Promise<void> => {
  await set(stateKey(id), state, store);
};

export const loadFileState = async (id: string): Promise<FileProcessingState | null> => {
  const data = await get<FileProcessingState | null>(stateKey(id), store);
  return data ?? null;
};

export const deleteFileState = async (id: string): Promise<void> => {
  await del(stateKey(id), store);
};

export const clearAllStorage = async (): Promise<void> => {
  await clear(store);
};

export const listStoredIds = async (): Promise<string[]> => {
  const all = await entries(store);
  const ids = new Set<string>();
  for (const [key] of all) {
    if (typeof key === 'string') {
      if (key.startsWith('file-')) ids.add(key.replace('file-', ''));
      if (key.startsWith('state-')) ids.add(key.replace('state-', ''));
    }
  }
  return Array.from(ids);
};
