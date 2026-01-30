import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import PDFViewer from '../components/PDFViewer';
import { removeRedMarkings } from '../services/geminiService';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { DEFAULT_TOAST_DURATION_MS, MAX_UPLOAD_FILES, STORAGE_KEY } from '../const/appConstants';
import type { FileProcessingState, PersistedState, Toast, UploadedFile } from '../models/appModels';
import {
  saveFileData,
  loadFileData,
  deleteFileData,
  saveFileState,
  loadFileState,
  deleteFileState,
  clearAllStorage,
} from '../services/storageService';

// Use a real Worker instance to avoid dynamic-import failures in dev/prod
pdfjsLib.GlobalWorkerOptions.workerPort = new pdfjsWorker();

const createInitialFileState = (): FileProcessingState => ({
  currentImageData: '',
  processedImageData: '',
  processedPages: [],
  previewPageIndex: 0,
  batchProgress: { current: 0, total: 0 },
  totalPages: 0,
  isBatchProcessing: false,
  error: '',
});

const generateFileId = (file: File): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 9)}`;
};

const getImageSources = (state: FileProcessingState): string[] => {
  if (state.processedPages.length > 0) return state.processedPages;
  if (state.processedImageData) return [state.processedImageData];
  return [];
};

const buildPdfFromImages = async (imageSources: string[]): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  for (const imageSource of imageSources) {
    const response = await fetch(imageSource);
    const imageBytes = new Uint8Array(await response.arrayBuffer());
    const isPng = imageSource.startsWith('data:image/png');
    const embedded = isPng ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes);
    const { width, height } = embedded.size();
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }

  const pdfBytes = await pdfDoc.save();
  const pdfBytesCopy = new Uint8Array(pdfBytes.byteLength);
  pdfBytesCopy.set(pdfBytes);
  return pdfBytesCopy;
};

const readFileAsDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('Không thể đọc file'));
    reader.readAsDataURL(file);
  });
};

const dataUrlToFile = (dataUrl: string, filename: string): File => {
  const [meta, base64] = dataUrl.split(',');
  const mimeMatch = meta.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
  const binary = atob(base64 || '');
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], filename, { type: mime });
};

type PDFProcessorProps = {
  onLogout?: () => void;
};

const PDFProcessor: React.FC<PDFProcessorProps> = ({ onLogout }) => {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string>('');
  const [fileStates, setFileStates] = useState<Record<string, FileProcessingState>>({});
  const [globalError, setGlobalError] = useState<string>('');
  const [isGlobalProcessing, setIsGlobalProcessing] = useState<boolean>(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
  const [fileSearchQuery, setFileSearchQuery] = useState<string>('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasHydratedRef = useRef<boolean>(false);

  const createToastId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const showToast = (message: string, type: Toast['type'] = 'info', durationMs = DEFAULT_TOAST_DURATION_MS) => {
    const id = createToastId();
    setToasts((prev) => {
      if (prev.some((toast) => toast.message === message && toast.type === type)) {
        return prev;
      }
      return [...prev, { id, message, type }];
    });

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, durationMs);
  };

  const activeFile = useMemo(() => {
    if (!uploadedFiles.length) return null;
    const selected = uploadedFiles.find((file) => file.id === activeFileId);
    return selected || uploadedFiles[0];
  }, [activeFileId, uploadedFiles]);

  const activeState = activeFile
    ? fileStates[activeFile.id] ?? createInitialFileState()
    : createInitialFileState();

  const filteredFiles = useMemo(() => {
    const query = fileSearchQuery.trim().toLowerCase();
    if (!query) return uploadedFiles;
    return uploadedFiles.filter((file) => file.name.toLowerCase().includes(query));
  }, [uploadedFiles, fileSearchQuery]);

  const anyFileProcessing = useMemo(() => {
    if (isGlobalProcessing) return true;
    return Object.values(fileStates).some((state) => state.isBatchProcessing);
  }, [fileStates, isGlobalProcessing]);

  const updateFileState = (fileId: string, updater: (prev: FileProcessingState) => FileProcessingState) => {
    if (!fileId) return;
    setFileStates((prev) => {
      const prevState = prev[fileId] ?? createInitialFileState();
      return {
        ...prev,
        [fileId]: updater(prevState),
      };
    });
  };

  const processSingleFile = async (file: UploadedFile) => {
    const fileId = file.id;
    updateFileState(fileId, (prev) => ({
      ...prev,
      isBatchProcessing: true,
      error: '',
      processedPages: [],
      processedImageData: '',
      previewPageIndex: 0,
      batchProgress: { current: 0, total: 0 },
    }));

    let pdfInstance: pdfjsLib.PDFDocumentProxy | null = null;

    try {
      const data = await file.file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data });
      pdfInstance = await loadingTask.promise;

      const total = pdfInstance.numPages;
      updateFileState(fileId, (prev) => ({
        ...prev,
        totalPages: total,
        batchProgress: { current: 0, total },
      }));

      const processed: string[] = [];

      for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
        const pageImage = await renderPdfPageToImage(pdfInstance, pageNumber, 1.75);
        const result = await removeRedMarkings(pageImage);
        if (!result.success || !result.processedImageUrl) {
          throw new Error(result.error || `Không thể xử lý trang ${pageNumber}`);
        }
        processed.push(result.processedImageUrl);
        updateFileState(fileId, (prev) => ({
          ...prev,
          batchProgress: { current: pageNumber, total },
        }));
      }

      updateFileState(fileId, (prev) => ({
        ...prev,
        processedPages: processed,
        processedImageData: processed[0] || '',
        previewPageIndex: 0,
        error: '',
      }));
    } catch (err) {
      updateFileState(fileId, (prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Lỗi khi xử lý PDF',
      }));
    } finally {
      updateFileState(fileId, (prev) => ({
        ...prev,
        isBatchProcessing: false,
      }));
      if (pdfInstance) {
        try {
          await pdfInstance.destroy();
        } catch {
          // ignore
        }
      }
    }
  };

  const handleProcessAllFiles = async () => {
    if (!uploadedFiles.length) {
      setGlobalError('Vui lòng thêm ít nhất một file PDF');
      return;
    }
    if (isGlobalProcessing) return;

    setGlobalError('');
    setIsGlobalProcessing(true);

    try {
      for (const file of uploadedFiles) {
        await processSingleFile(file);
      }
    } finally {
      setIsGlobalProcessing(false);
    }
  };

  const handleFilesAdded = async (files: File[]) => {
    if (!files.length) return;
    if (isGlobalProcessing) {
      setGlobalError('Đang xử lý, vui lòng đợi hoàn tất trước khi thêm file mới');
      showToast('Đang xử lý, vui lòng đợi hoàn tất trước khi thêm file mới', 'warning');
      return;
    }

    // Giới hạn tổng số file upload
    const remainingSlots = Math.max(MAX_UPLOAD_FILES - uploadedFiles.length, 0);
    if (remainingSlots === 0) {
      setGlobalError(`Chỉ được upload tối đa ${MAX_UPLOAD_FILES} file PDF`);
      showToast(`Chỉ được upload tối đa ${MAX_UPLOAD_FILES} file PDF`, 'warning');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const pdfFiles = files.filter((file) => file.type === 'application/pdf');
    if (!pdfFiles.length) {
      setGlobalError('Vui lòng chọn file PDF');
      showToast('Vui lòng chọn file PDF', 'warning');
      return;
    }

    const limitedPdfFiles = pdfFiles.slice(0, remainingSlots);
    if (pdfFiles.length > remainingSlots) {
      setGlobalError(`Chỉ được upload tối đa ${MAX_UPLOAD_FILES} file PDF (đã lấy ${remainingSlots} file đầu tiên)`);
      showToast(`Đã lấy ${remainingSlots}/${pdfFiles.length} file (giới hạn ${MAX_UPLOAD_FILES} file)`, 'warning');
    }

    let newEntries: UploadedFile[] = [];
    try {
      newEntries = await Promise.all(
        limitedPdfFiles.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          return {
            id: generateFileId(file),
            file,
            name: file.name,
            dataUrl,
          };
        })
      );
    } catch (error) {
      setGlobalError('Không thể đọc file, vui lòng thử lại.');
      showToast('Không thể đọc file, vui lòng thử lại.', 'error');
      return;
    }

    setUploadedFiles((prev) => {
      const nextList = [...prev, ...newEntries];

      setFileStates((prevStates) => {
        const nextStates = { ...prevStates };
        newEntries.forEach(({ id }) => {
          nextStates[id] = createInitialFileState();
        });
        return nextStates;
      });

      setActiveFileId((current) => current || newEntries[0]?.id || '');
      if (!globalError) setGlobalError('');
      if (newEntries.length) {
        showToast(`Đã thêm ${newEntries.length} file PDF`, 'success');
      }
      return nextList;
    });

    // Lưu dataUrl vào IndexedDB để giữ sau reload
    try {
      await Promise.all(newEntries.map((f) => saveFileData(f.id, f.dataUrl)));
    } catch (error) {
      console.warn('Không thể lưu dữ liệu file vào bộ nhớ cục bộ', error);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    await handleFilesAdded(files);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    await handleFilesAdded(files);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleSelectFile = (id: string) => {
    setActiveFileId(id);
  };

  const handleRemoveFile = (id: string) => {
    if (isGlobalProcessing) {
      setGlobalError('Không thể xóa file khi đang xử lý hàng loạt');
      return;
    }
    setUploadedFiles((prev) => {
      const next = prev.filter((file) => file.id !== id);
      setActiveFileId((current) => {
        if (current === id) {
          return next[0]?.id ?? '';
        }
        return current;
      });
      if (!next.length) {
        setGlobalError('');
      }
      return next;
    });

    setFileStates((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    // Xóa dữ liệu lưu trong IndexedDB
    deleteFileData(id).catch(() => {});
    deleteFileState(id).catch(() => {});
  };

  const handleResetWorkspace = () => {
    if (anyFileProcessing) {
      setGlobalError('Đang xử lý, vui lòng đợi hoàn tất trước khi làm mới');
      return;
    }

    setUploadedFiles([]);
    setFileStates({});
    setActiveFileId('');
    setGlobalError('');
    setIsDownloadingAll(false);

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }

    clearAllStorage().catch(() => {});

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePDFToImage = (imageData: string) => {
    if (!activeFile) return;
    updateFileState(activeFile.id, (prev) => ({
      ...prev,
      currentImageData: imageData,
    }));
  };

  const handleDocumentLoad = ({ numPages }: { numPages: number }) => {
    if (!activeFile) return;
    updateFileState(activeFile.id, (prev) => ({
      ...prev,
      totalPages: numPages,
      batchProgress: numPages === 0 ? { current: 0, total: 0 } : { ...prev.batchProgress, total: numPages },
      previewPageIndex: numPages === 0 ? 0 : prev.previewPageIndex,
    }));
  };

  const handleDownloadPdf = async () => {
    if (!activeFile) {
      setGlobalError('Vui lòng chọn file PDF');
      return;
    }

    const state = fileStates[activeFile.id] ?? createInitialFileState();
    const imageSources = state.processedPages.length > 0
      ? state.processedPages
      : state.processedImageData
        ? [state.processedImageData]
        : [];

    if (!imageSources.length) {
      updateFileState(activeFile.id, (prev) => ({
        ...prev,
        error: 'Chưa có dữ liệu để tải xuống',
      }));
      return;
    }

    try {
      const pdfDoc = await PDFDocument.create();
      for (const imageSource of imageSources) {
        const response = await fetch(imageSource);
        const imageBytes = new Uint8Array(await response.arrayBuffer());
        const isPng = imageSource.startsWith('data:image/png');
        const embedded = isPng ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes);
        const { width, height } = embedded.size();
        const page = pdfDoc.addPage([width, height]);
        page.drawImage(embedded, { x: 0, y: 0, width, height });
      }

      const pdfBytes = await pdfDoc.save();
      const pdfBytesCopy = new Uint8Array(pdfBytes.byteLength);
      pdfBytesCopy.set(pdfBytes);
      const blob = new Blob([pdfBytesCopy.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      const baseName = activeFile.file.name.replace(/\.pdf$/i, '') || 'document';
      const multiSuffix = imageSources.length > 1 ? '_multi' : '';
      link.download = `processed_${baseName}${multiSuffix}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Không thể tạo PDF để tải xuống';
      updateFileState(activeFile.id, (prev) => ({
        ...prev,
        error: message,
      }));
    }
  };

  const handleDownloadAll = async () => {
    if (!uploadedFiles.length) {
      setGlobalError('Chưa có file nào để tải xuống');
      return;
    }
    if (isDownloadingAll) return;

    setGlobalError('');
    setIsDownloadingAll(true);

    try {
      const zip = new JSZip();
      let addedFiles = 0;

      for (const file of uploadedFiles) {
        const state = fileStates[file.id] ?? createInitialFileState();
        const imageSources = getImageSources(state);
        if (!imageSources.length) continue;

        const pdfBytes = await buildPdfFromImages(imageSources);
        const baseName = file.file.name.replace(/\.pdf$/i, '') || 'document';
        const multiSuffix = imageSources.length > 1 ? '_multi' : '';
        zip.file(`processed_${baseName}${multiSuffix}.pdf`, pdfBytes);
        addedFiles += 1;
      }

      if (!addedFiles) {
        setGlobalError('Chưa có file nào đã xử lý để tải xuống');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'processed_pdfs.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể tải tất cả file';
      setGlobalError(message);
    } finally {
      setIsDownloadingAll(false);
    }
  };

  const hasBatchResult = activeState.processedPages.length > 0;
  const previewImage = hasBatchResult
    ? activeState.processedPages[activeState.previewPageIndex]
    : activeState.processedImageData;
  const processAllDisabled = isGlobalProcessing || uploadedFiles.length === 0;
  const downloadDisabled = !previewImage || activeState.isBatchProcessing || isGlobalProcessing;
  const hasAnyProcessed = uploadedFiles.some((file) => {
    const state = fileStates[file.id] ?? createInitialFileState();
    return getImageSources(state).length > 0;
  });
  const hasUnprocessedFiles = uploadedFiles.some((file) => {
    const state = fileStates[file.id] ?? createInitialFileState();
    return getImageSources(state).length === 0;
  });
  const downloadAllDisabled = isGlobalProcessing || isDownloadingAll || !hasAnyProcessed;
  const resetDisabled = anyFileProcessing || (uploadedFiles.length === 0 && !globalError);
  const fileCountLabel = filteredFiles.length === uploadedFiles.length
    ? `${uploadedFiles.length} file`
    : `${filteredFiles.length}/${uploadedFiles.length} file`;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      hasHydratedRef.current = true;
      return;
    }

    (async () => {
      try {
        const parsed = JSON.parse(raw) as PersistedState;
        const restoredFiles: UploadedFile[] = [];
        for (const item of parsed.files) {
          const dataUrl = await loadFileData(item.id);
          if (!dataUrl) continue;
          restoredFiles.push({
            id: item.id,
            name: item.name,
            dataUrl,
            file: dataUrlToFile(dataUrl, item.name),
          });
        }

        const restoredStates: Record<string, FileProcessingState> = {};
        for (const file of restoredFiles) {
          const state = await loadFileState(file.id);
          restoredStates[file.id] = state ?? createInitialFileState();
        }

        setUploadedFiles(restoredFiles);
        setFileStates(restoredStates);
        const validActiveId = parsed.activeFileId && restoredFiles.find((f) => f.id === parsed.activeFileId)
          ? parsed.activeFileId
          : restoredFiles[0]?.id ?? '';
        setActiveFileId(validActiveId);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
        await clearAllStorage();
      } finally {
        hasHydratedRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!hasHydratedRef.current) return;

    (async () => {
      if (!uploadedFiles.length && Object.keys(fileStates).length === 0) {
        window.localStorage.removeItem(STORAGE_KEY);
        await clearAllStorage();
        return;
      }

      const payload: PersistedState = {
        activeFileId,
        files: uploadedFiles.map(({ id, name }) => ({ id, name, dataUrl: '' })),
        fileStates: {},
      };

      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (error) {
        console.warn('Không thể lưu trạng thái cục bộ', error);
      }

      // Persist file data and states in IndexedDB
      await Promise.all(
        uploadedFiles.map(async (file) => {
          try {
            await saveFileData(file.id, file.dataUrl);
            const state = fileStates[file.id];
            if (state) {
              await saveFileState(file.id, state);
            }
          } catch (error) {
            console.warn('Không thể lưu dữ liệu file', error);
          }
        })
      );
    })();
  }, [uploadedFiles, fileStates, activeFileId]);

  const handlePreviewChange = (direction: number) => {
    if (!activeFile) return;
    updateFileState(activeFile.id, (prev) => {
      const maxIndex = Math.max(prev.processedPages.length - 1, 0);
      const nextIndex = Math.min(Math.max(prev.previewPageIndex + direction, 0), maxIndex);
      return {
        ...prev,
        previewPageIndex: nextIndex,
      };
    });
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-0.5 sm:px-1 lg:px-2 py-8 space-y-6">
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-3" aria-live="polite" aria-atomic="true">
          {toasts.map((toast) => {
            const base = 'rounded-lg px-4 py-3 shadow-lg text-white font-semibold';
            const tone = {
              info: 'bg-sky-500',
              success: 'bg-emerald-500',
              warning: 'bg-amber-500 text-slate-900',
              error: 'bg-rose-500',
            }[toast.type];
            return (
              <div key={toast.id} className={`${base} ${tone}`}>
                {toast.message}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800">Xử lý PDF - Xóa đường viết màu đỏ</h1>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-emerald-600 px-4 py-2 text-emerald-700 font-semibold bg-white shadow-sm hover:bg-emerald-50 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={handleResetWorkspace}
              disabled={resetDisabled}
              aria-label="Làm mới workspace"
            >
              🔄 Làm mới workspace
            </button>
            {onLogout && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full border border-rose-500 px-4 py-2 text-rose-600 font-semibold bg-white shadow-sm hover:bg-rose-50"
                onClick={onLogout}
                aria-label="Đăng xuất"
              >
                Đăng xuất
              </button>
            )}
          </div>
        </div>

        {(() => {
          const atLimit = uploadedFiles.length >= MAX_UPLOAD_FILES;
          return (
            <div
              className={`w-full rounded-xl border-2 border-dashed ${atLimit ? 'border-rose-300 bg-rose-50 text-rose-600' : 'border-emerald-300 bg-white text-slate-700'} ${uploadedFiles.length ? 'py-5 px-3 sm:px-4' : 'py-8 sm:py-10 px-4 sm:px-6'} transition text-center`}
              onDrop={atLimit ? undefined : handleDrop}
              onDragOver={atLimit ? undefined : handleDragOver}
              onClick={atLimit ? undefined : () => fileInputRef.current?.click()}
              style={atLimit ? { cursor: 'not-allowed' } : { cursor: 'pointer' }}
            >
              <div className="pointer-events-none flex flex-col items-center gap-2 text-center">
                <div className="text-4xl sm:text-5xl">📄</div>
                <p className="text-base sm:text-lg font-semibold">
                  {atLimit
                    ? `Đã đạt giới hạn ${MAX_UPLOAD_FILES} file PDF`
                    : uploadedFiles.length
                      ? 'Thêm file PDF khác (có thể chọn nhiều)'
                      : 'Kéo thả file PDF vào đây hoặc click để chọn file'}
                </p>
                <p className="text-xs sm:text-sm text-slate-500">
                  Đang có {uploadedFiles.length}/{MAX_UPLOAD_FILES} file. {atLimit ? 'Hãy xóa bớt để thêm mới.' : 'Kéo nhiều file cùng lúc để xử lý hàng loạt.'}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  multiple
                  disabled={atLimit}
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>
            </div>
          );
        })()}

        {globalError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700 font-semibold">
            ❌ {globalError}
          </div>
        )}

        {uploadedFiles.length === 0 ? (
          <div className="text-center text-slate-500 italic py-10">Chưa có file nào được tải lên.</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr,320px]">
            <div className="flex flex-col gap-4">
              {activeFile ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-baseline gap-2 text-slate-800 font-semibold">
                      <span className="truncate">📄 {activeFile.name}</span>
                      {activeState.totalPages > 0 && (
                        <span className="text-sm font-medium text-slate-500">({activeState.totalPages} trang)</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveFile(activeFile.id)}
                      className="inline-flex items-center gap-2 rounded-md bg-rose-500 px-3 py-2 text-white font-semibold shadow hover:bg-rose-600"
                    >
                      Xóa file này
                    </button>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-3 min-h-[320px]">
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold text-slate-800">PDF gốc</h2>
                      </div>
                      <div className="flex-1 min-h-[280px]">
                        <PDFViewer
                          file={activeFile.file}
                          onPDFToImage={handlePDFToImage}
                          onDocumentLoad={handleDocumentLoad}
                        />
                      </div>
                    </div>

                    {previewImage && (
                      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-3 min-h-[320px]">
                        <div className="flex items-center gap-2">
                          <h2 className="text-lg font-semibold text-slate-800">Kết quả sau xử lý</h2>
                        </div>
                        <div className="flex-1 flex flex-col gap-3">
                          {hasBatchResult && (
                            <div className="flex items-center justify-center gap-3">
                              <button
                                onClick={() => handlePreviewChange(-1)}
                                disabled={activeState.previewPageIndex === 0}
                                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-50"
                              >
                                ← Trước
                              </button>
                              <span className="text-sm text-slate-700">
                                Trang {activeState.previewPageIndex + 1} / {activeState.processedPages.length}
                              </span>
                              <button
                                onClick={() => handlePreviewChange(1)}
                                disabled={activeState.previewPageIndex >= activeState.processedPages.length - 1}
                                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-50"
                              >
                                Sau →
                              </button>
                            </div>
                          )}
                          <div className="flex-1 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 flex justify-center items-center max-h-[70vh]">
                            <img src={previewImage} alt="Processed PDF preview" className="max-w-full h-auto shadow" />
                          </div>
                          {hasBatchResult && (
                            <div className="text-center text-sm font-semibold text-emerald-600">
                              Đã xử lý {activeState.processedPages.length} / {activeState.totalPages || activeState.processedPages.length} trang
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-center gap-3 rounded-lg bg-white px-4 py-3 shadow-sm border border-slate-200">
                    {hasUnprocessedFiles && (
                      <button
                        onClick={handleProcessAllFiles}
                        disabled={processAllDisabled}
                        className="inline-flex w-full sm:w-auto items-center gap-2 rounded-md bg-emerald-600 px-4 py-3 text-white font-semibold shadow hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isGlobalProcessing
                          ? '🌀 Đang xử lý tất cả file...'
                          : uploadedFiles.length > 1
                            ? '🤖 Xóa vết chấm của giáo viên trên tất cả file'
                            : '🤖 Xóa vết chấm của giáo viên trên file này'}
                      </button>
                    )}

                    {previewImage && (
                      <button
                        onClick={handleDownloadPdf}
                        className="inline-flex w-full sm:w-auto items-center gap-2 rounded-md bg-sky-600 px-4 py-3 text-white font-semibold shadow hover:bg-sky-700 disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={downloadDisabled}
                      >
                        {hasBatchResult ? '⬇️ Tải xuống PDF (đa trang)' : '⬇️ Tải xuống (PDF)'}
                      </button>
                    )}

                    {uploadedFiles.length > 1 && hasAnyProcessed && (
                      <button
                        onClick={handleDownloadAll}
                        className="inline-flex w-full sm:w-auto items-center gap-2 rounded-md bg-amber-500 px-4 py-3 text-white font-semibold shadow hover:bg-amber-600 disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={downloadAllDisabled}
                      >
                        {isDownloadingAll ? '📦 Đang gom tất cả...' : '📦 Tải tất cả file đã xử lý'}
                      </button>
                    )}
                  </div>

                  {activeState.batchProgress.total > 0 && (
                    <div
                      className={`rounded-md border px-4 py-3 text-sm font-semibold shadow-sm ${
                        !activeState.isBatchProcessing &&
                        activeState.batchProgress.current === activeState.batchProgress.total
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700'
                      }`}
                    >
                      {activeState.isBatchProcessing
                        ? `Đang xử lý ${Math.min(activeState.batchProgress.current, activeState.batchProgress.total)}/${activeState.batchProgress.total} trang...`
                        : `Đã xử lý ${activeState.batchProgress.current}/${activeState.batchProgress.total} trang`}
                    </div>
                  )}

                  {activeState.error && (
                    <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700 font-semibold">
                      ❌ {activeState.error}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center text-slate-500 italic py-10">Hãy chọn một file để tiếp tục.</div>
              )}
            </div>

            <aside className="rounded-lg border border-slate-200 bg-white shadow-sm p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-slate-800">Danh sách file</h3>
                <span className="text-sm text-slate-500">{fileCountLabel}</span>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={fileSearchQuery}
                  placeholder="Tìm theo tên file..."
                  onChange={(event) => setFileSearchQuery(event.target.value)}
                  aria-label="Tìm kiếm file theo tên"
                  className="w-full rounded-full border border-slate-200 px-4 py-2 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
                {fileSearchQuery && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2 text-slate-500 hover:bg-slate-100"
                    onClick={() => setFileSearchQuery('')}
                    aria-label="Xóa từ khóa tìm kiếm"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2 overflow-auto pr-1 max-h-[70vh]">
                {filteredFiles.length ? filteredFiles.map((file) => {
                  const state = fileStates[file.id] ?? createInitialFileState();
                  const hasResult = getImageSources(state).length > 0;
                  const sidebarStatus = state.isBatchProcessing
                    ? 'Đang xử lý'
                    : hasResult
                      ? 'Đã xử lý'
                      : 'Chưa xử lý';
                  const totalPagesForProgress = state.batchProgress.total || state.totalPages || 0;
                  const progressValue = totalPagesForProgress
                    ? Math.min(
                        100,
                        Math.round((state.batchProgress.current / totalPagesForProgress) * 100)
                      )
                    : 0;

                  return (
                    <button
                      key={file.id}
                      type="button"
                      className={`w-full rounded-lg border px-3 py-2 text-left shadow-sm transition hover:shadow ${activeFile?.id === file.id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}
                      onClick={() => handleSelectFile(file.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-800 truncate">{file.name}</span>
                        <span
                          className="text-rose-500 font-bold"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveFile(file.id);
                          }}
                          aria-label="Xóa file"
                        >
                          ✕
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm text-slate-600">
                        <span>
                          {state.totalPages
                            ? `${state.totalPages} trang`
                            : state.isBatchProcessing
                              ? 'Đang đọc số trang...'
                              : 'Chưa đọc số trang'}
                        </span>
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            state.isBatchProcessing
                              ? 'bg-amber-100 text-amber-700'
                              : hasResult
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {sidebarStatus}
                        </span>
                      </div>
                      {state.isBatchProcessing && totalPagesForProgress > 0 && (
                        <div className="mt-2 h-2 rounded-full bg-slate-100">
                          <div className="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-lime-400" style={{ width: `${progressValue}%` }} />
                        </div>
                      )}
                    </button>
                  );
                }) : (
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                    Không tìm thấy file phù hợp.
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
};

const renderPdfPageToImage = async (
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale = 1.5
): Promise<string> => {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Không thể tạo canvas để render PDF');
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas.toDataURL('image/png');
};

export default PDFProcessor;
