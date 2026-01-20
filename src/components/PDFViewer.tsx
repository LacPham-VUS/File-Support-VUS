import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Cấu hình worker cho pdf.js (tương thích Vite)
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface PDFViewerProps {
  file: File | null;
  onPDFToImage?: (imageData: string) => void;
}

const PDFViewer: React.FC<PDFViewerProps> = ({ file, onPDFToImage }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.25);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const canRender = useMemo(() => !!file, [file]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!file) {
        setNumPages(0);
        setPageNumber(1);
        setError('');
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
        setNumPages(pdf.numPages);
        setPageNumber(1);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Không thể tải PDF';
        setError(message);
        setNumPages(0);
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
    const render = async () => {
      if (!pdfRef.current || !canvasRef.current) return;
      if (pageNumber < 1 || pageNumber > (numPages || 1)) return;

      // hủy render cũ nếu có
      try {
        renderTaskRef.current?.cancel();
      } catch {
        // ignore
      }

      const page = await pdfRef.current.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
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

      if (onPDFToImage) {
        const imageData = canvas.toDataURL('image/png');
        onPDFToImage(imageData);
      }
    };

    render().catch((e) => {
      const message = e instanceof Error ? e.message : 'Không thể render PDF';
      setError(message);
    });
  }, [numPages, onPDFToImage, pageNumber, scale]);

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
