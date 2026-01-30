export type Toast = {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
};

export type FileProcessingState = {
  currentImageData: string;
  processedImageData: string;
  processedPages: string[];
  previewPageIndex: number;
  batchProgress: { current: number; total: number };
  totalPages: number;
  isBatchProcessing: boolean;
  error: string;
};

export type UploadedFile = {
  id: string;
  file: File;
  name: string;
  dataUrl: string;
};

export type PersistedFile = {
  id: string;
  name: string;
  dataUrl: string;
};

export type PersistedState = {
  files: PersistedFile[];
  fileStates: Record<string, FileProcessingState>;
  activeFileId: string;
};
