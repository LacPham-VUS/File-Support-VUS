import React, { useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import PDFViewer from '../components/PDFViewer';
import { removeRedMarkings } from '../services/geminiService';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import './PDFProcessor.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

type FileProcessingState = {
  currentImageData: string;
  processedImageData: string;
  processedPages: string[];
  previewPageIndex: number;
  batchProgress: { current: number; total: number };
  totalPages: number;
  isBatchProcessing: boolean;
  error: string;
};

type UploadedFile = {
  id: string;
  file: File;
  name: string;
};

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

const PDFProcessor: React.FC = () => {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string>('');
  const [fileStates, setFileStates] = useState<Record<string, FileProcessingState>>({});
  const [globalError, setGlobalError] = useState<string>('');
  const [isGlobalProcessing, setIsGlobalProcessing] = useState<boolean>(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
  const [zoomOverlay, setZoomOverlay] = useState<{ src: string; title: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeFile = useMemo(() => {
    if (!uploadedFiles.length) return null;
    const selected = uploadedFiles.find((file) => file.id === activeFileId);
    return selected || uploadedFiles[0];
  }, [activeFileId, uploadedFiles]);

  const activeState = activeFile
    ? fileStates[activeFile.id] ?? createInitialFileState()
    : createInitialFileState();

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

  const handleOpenZoomOverlay = (src: string | null | undefined, title: string) => {
    if (!src) return;
    setZoomOverlay({ src, title });
  };

  const handleCloseZoomOverlay = () => {
    setZoomOverlay(null);
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

  const handleFilesAdded = (files: File[]) => {
    if (!files.length) return;
    if (isGlobalProcessing) {
      setGlobalError('Đang xử lý, vui lòng đợi hoàn tất trước khi thêm file mới');
      return;
    }
    const pdfFiles = files.filter((file) => file.type === 'application/pdf');
    if (!pdfFiles.length) {
      setGlobalError('Vui lòng chọn file PDF');
      return;
    }

    setUploadedFiles((prev) => {
      const newEntries = pdfFiles.map((file) => ({
        id: generateFileId(file),
        file,
        name: file.name,
      }));

      setFileStates((prevStates) => {
        const nextStates = { ...prevStates };
        newEntries.forEach(({ id }) => {
          nextStates[id] = createInitialFileState();
        });
        return nextStates;
      });

      setActiveFileId((current) => current || newEntries[0]?.id || '');
      setGlobalError('');
      return [...prev, ...newEntries];
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    handleFilesAdded(files);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    handleFilesAdded(files);
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
    setZoomOverlay(null);
    setIsDownloadingAll(false);

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
  const downloadAllDisabled = isGlobalProcessing || isDownloadingAll || !hasAnyProcessed;
  const resetDisabled = anyFileProcessing || (uploadedFiles.length === 0 && !zoomOverlay && !globalError);

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
    <div className="pdf-processor-container">
      <h1>Xử lý PDF - Xóa đường viết màu đỏ</h1>
      <div className="top-actions">
        <button
          type="button"
          className="btn-refresh"
          onClick={handleResetWorkspace}
          disabled={resetDisabled}
          aria-label="Làm mới workspace"
        >
          🔄 Làm mới workspace
        </button>
      </div>

      <div
        className={`upload-zone ${uploadedFiles.length ? 'upload-zone--compact' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="upload-content">
          <div className="upload-icon">📄</div>
          <p>
            {uploadedFiles.length
              ? 'Thêm file PDF khác (có thể chọn nhiều)'
              : 'Kéo thả file PDF vào đây hoặc click để chọn file'}
          </p>
          <small>Kéo nhiều file cùng lúc để xử lý hàng loạt.</small>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>
      </div>

      {globalError && <div className="error-message">❌ {globalError}</div>}

      {uploadedFiles.length === 0 ? (
        <div className="empty-hint">Chưa có file nào được tải lên.</div>
      ) : (
        <div className="workspace-layout">
          <div className="processing-column">
            {activeFile ? (
              <div className="processing-area">
              <div className="file-info">
                <div className="file-name">
                  <span>📄 {activeFile.name}</span>
                  {activeState.totalPages > 0 && <span className="file-meta">({activeState.totalPages} trang)</span>}
                </div>
                <button onClick={() => handleRemoveFile(activeFile.id)} className="btn-secondary">
                  Xóa file này
                </button>
              </div>

              <div className="viewer-section">
                <div className="original-section">
                  <div className="section-header">
                    <h2>PDF gốc</h2>
                    <button
                      type="button"
                      className="zoom-button"
                      onClick={() => handleOpenZoomOverlay(activeState.currentImageData, 'PDF gốc')}
                      disabled={!activeState.currentImageData}
                      aria-label="Phóng to PDF gốc"
                    >
                      🔍
                    </button>
                  </div>
                  <PDFViewer
                    file={activeFile.file}
                    onPDFToImage={handlePDFToImage}
                    onDocumentLoad={handleDocumentLoad}
                  />
                </div>

                {previewImage && (
                  <div className="processed-section">
                    <div className="section-header">
                      <h2>Kết quả sau xử lý</h2>
                      <button
                        type="button"
                        className="zoom-button"
                        onClick={() => handleOpenZoomOverlay(previewImage, 'Kết quả sau xử lý')}
                        disabled={!previewImage}
                        aria-label="Phóng to kết quả sau xử lý"
                      >
                        🔍
                      </button>
                    </div>
                    <div className="processed-content">
                      {hasBatchResult && (
                        <div className="processed-preview-controls">
                          <button onClick={() => handlePreviewChange(-1)} disabled={activeState.previewPageIndex === 0}>
                            ← Trước
                          </button>
                          <span>
                            Trang {activeState.previewPageIndex + 1} / {activeState.processedPages.length}
                          </span>
                          <button
                            onClick={() => handlePreviewChange(1)}
                            disabled={activeState.previewPageIndex >= activeState.processedPages.length - 1}
                          >
                            Sau →
                          </button>
                        </div>
                      )}
                      <div className="processed-image-container">
                        <img src={previewImage} alt="Processed PDF preview" />
                      </div>
                      {hasBatchResult && (
                        <div className="batch-summary">
                          Đã xử lý {activeState.processedPages.length} / {activeState.totalPages || activeState.processedPages.length} trang
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="action-buttons">
                <button onClick={handleProcessAllFiles} disabled={processAllDisabled} className="btn-primary">
                  {isGlobalProcessing
                    ? '🌀 Đang xử lý tất cả file...'
                    : uploadedFiles.length > 1
                      ? '🤖 Xóa đường đỏ tất cả file'
                      : '🤖 Xóa đường đỏ file này'}
                </button>

                {previewImage && (
                  <button onClick={handleDownloadPdf} className="btn-success" disabled={downloadDisabled}>
                    {hasBatchResult ? '⬇️ Tải xuống PDF (đa trang)' : '⬇️ Tải xuống (PDF)'}
                  </button>
                )}

                {uploadedFiles.length > 1 && hasAnyProcessed && (
                  <button
                    onClick={handleDownloadAll}
                    className="btn-secondary"
                    disabled={downloadAllDisabled}
                  >
                    {isDownloadingAll ? '📦 Đang gom tất cả...' : '📦 Tải tất cả file đã xử lý'}
                  </button>
                )}
              </div>

              {activeState.batchProgress.total > 0 && (
                <div
                  className={`batch-progress ${
                    !activeState.isBatchProcessing &&
                    activeState.batchProgress.current === activeState.batchProgress.total
                      ? 'completed'
                      : ''
                  }`}
                >
                  {activeState.isBatchProcessing
                    ? `Đang xử lý ${Math.min(activeState.batchProgress.current, activeState.batchProgress.total)}/${activeState.batchProgress.total} trang...`
                    : `Đã xử lý ${activeState.batchProgress.current}/${activeState.batchProgress.total} trang`}
                </div>
              )}

              {activeState.error && <div className="error-message">❌ {activeState.error}</div>}
            </div>
            ) : (
              <div className="empty-hint">Hãy chọn một file để tiếp tục.</div>
            )}
          </div>

          <aside className="file-sidebar">
            <div className="file-sidebar__inner">
              <div className="file-sidebar__header">
                <h3>Danh sách file</h3>
                <span>{uploadedFiles.length} file</span>
              </div>
              <div className="file-sidebar__list">
                {uploadedFiles.map((file) => {
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
                      className={`file-card ${activeFile?.id === file.id ? 'active' : ''}`}
                      onClick={() => handleSelectFile(file.id)}
                    >
                      <div className="file-card__row">
                        <span className="file-card__name">{file.name}</span>
                        <span
                          className="file-card__remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveFile(file.id);
                          }}
                          aria-label="Xóa file"
                        >
                          ✕
                        </span>
                      </div>
                      <div className="file-card__meta">
                        <span>
                          {state.totalPages
                            ? `${state.totalPages} trang`
                            : state.isBatchProcessing
                              ? 'Đang đọc số trang...'
                              : 'Chưa đọc số trang'}
                        </span>
                        <span
                          className={`file-card__badge ${
                            state.isBatchProcessing
                              ? 'file-card__badge--processing'
                              : hasResult
                                ? 'file-card__badge--done'
                                : 'file-card__badge--pending'
                          }`}
                        >
                          {sidebarStatus}
                        </span>
                      </div>
                      {state.isBatchProcessing && totalPagesForProgress > 0 && (
                        <div className="file-card__progress">
                          <div style={{ width: `${progressValue}%` }} />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      )}

      {zoomOverlay && (
        <div className="zoom-overlay" role="dialog" aria-modal="true" onClick={handleCloseZoomOverlay}>
          <div className="zoom-overlay__content" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="zoom-overlay__close"
              aria-label="Đóng phóng to"
              onClick={handleCloseZoomOverlay}
            >
              ✕
            </button>
            <h3>{zoomOverlay.title}</h3>
            <img src={zoomOverlay.src} alt={`Phóng to ${zoomOverlay.title}`} />
          </div>
        </div>
      )}
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
