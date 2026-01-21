import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Cấu hình worker cho pdf.js (tương thích Vite)
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface PDFViewerProps {
  file: File | null;
  onPDFToImage?: (imageData: string) => void;
  onDocumentLoad?: (info: { numPages: number }) => void;
}

const PDFViewer: React.FC<PDFViewerProps> = ({ file, onPDFToImage, onDocumentLoad }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const renderCacheRef = useRef<Map<number, CachedPage>>(new Map());
  const renderTokenRef = useRef(0);
  const onDocumentLoadRef = useRef<PDFViewerProps['onDocumentLoad']>(onDocumentLoad);
  const onPDFToImageRef = useRef<PDFViewerProps['onPDFToImage']>(onPDFToImage);

  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.25);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const canRender = useMemo(() => !!file, [file]);

  useEffect(() => {
    onDocumentLoadRef.current = onDocumentLoad;
  }, [onDocumentLoad]);

  useEffect(() => {
    onPDFToImageRef.current = onPDFToImage;
  }, [onPDFToImage]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!file) {
        setNumPages(0);
        setPageNumber(1);
        setError('');
        onDocumentLoadRef.current?.({ numPages: 0 });
        return;
      }

      setIsLoading(true);
      setError('');

      try {
        const data = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          try {
            await pdf.destroy();
          } catch {
            // ignore
          }
          return;
        }

        if (pdfRef.current) {
          try {
            await pdfRef.current.destroy();
          } catch {
            // ignore
          }
        }

        pdfRef.current = pdf;
        renderCacheRef.current.clear();
        setNumPages(pdf.numPages);
        setPageNumber(1);
        onDocumentLoadRef.current?.({ numPages: pdf.numPages });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Không thể tải PDF';
        setError(message);
        setNumPages(0);
        onDocumentLoadRef.current?.({ numPages: 0 });
      } finally {
        setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    renderCacheRef.current.clear();
  }, [scale, file]);

  useEffect(() => {
    const render = async () => {
      if (isLoading) return;
      if (!pdfRef.current || !canvasRef.current) return;
      if (pageNumber < 1 || pageNumber > (numPages || 1)) return;

      const canvas = canvasRef.current;
      const token = ++renderTokenRef.current;

      // hủy render cũ nếu có
      try {
        renderTaskRef.current?.cancel();
      } catch {
        // ignore
      }

      const cached = renderCacheRef.current.get(pageNumber);
      if (cached) {
        await drawCachedPage(canvas, cached, token, renderTokenRef);
        if (token === renderTokenRef.current) {
          onPDFToImageRef.current?.(cached.dataUrl);
        }
        return;
      }

      const page = await pdfRef.current.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);

      const task = page.render({ canvasContext: ctx, viewport, canvas });
      renderTaskRef.current = task;
      await task.promise;

      if (token !== renderTokenRef.current) {
        return;
      }

      const imageData = canvas.toDataURL('image/png');
      renderCacheRef.current.set(pageNumber, {
        dataUrl: imageData,
        cssWidth: Math.floor(viewport.width),
        cssHeight: Math.floor(viewport.height),
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
      });
      onPDFToImageRef.current?.(imageData);
    };

    render().catch((e) => {
      const message = e instanceof Error ? e.message : 'Không thể render PDF';
      setError(message);
    });
  }, [isLoading, numPages, pageNumber, scale]);

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.2, 3.0));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.2, 0.5));
  };

  const handleResetZoom = () => {
    setScale(1.25);
  };

  const handlePreviousPage = () => {
    setPageNumber((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setPageNumber((prev) => Math.min(prev + 1, numPages));
  };

  if (!file) {
    return null;
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-controls">
        <div className="zoom-controls">
          <button onClick={handleZoomOut} title="Thu nhỏ">
            🔍−
          </button>
          <button onClick={handleResetZoom} title="Đặt lại">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={handleZoomIn} title="Phóng to">
            🔍+
          </button>
        </div>
        
        <div className="page-controls">
          <button onClick={handlePreviousPage} disabled={pageNumber <= 1}>
            ← Trước
          </button>
          <span>
            Trang {pageNumber} / {numPages}
          </span>
          <button onClick={handleNextPage} disabled={pageNumber >= numPages}>
            Sau →
          </button>
        </div>
      </div>

      <div className="pdf-document">
        {!canRender ? null : isLoading ? (
          <div>Đang tải PDF...</div>
        ) : error ? (
          <div style={{ color: '#c62828' }}>Không thể tải PDF: {error}</div>
        ) : (
          <canvas ref={canvasRef} />
        )}
      </div>
    </div>
  );
};

export default PDFViewer;

type CachedPage = {
  dataUrl: string;
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
};

const drawCachedPage = (
  canvas: HTMLCanvasElement,
  cached: CachedPage,
  token: number,
  renderTokenRef: React.MutableRefObject<number>
) => {
  return new Promise<void>((resolve) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve();
      return;
    }

    canvas.width = cached.pixelWidth;
    canvas.height = cached.pixelHeight;
    canvas.style.width = `${cached.cssWidth}px`;
    canvas.style.height = `${cached.cssHeight}px`;

    const img = new Image();
    img.onload = () => {
      if (token !== renderTokenRef.current) {
        resolve();
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = cached.dataUrl;
  });
};
