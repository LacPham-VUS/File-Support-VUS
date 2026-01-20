import React, { useState, useRef } from 'react';
import PDFViewer from '../components/PDFViewer';
import { removeRedMarkings } from '../services/geminiService';
import { PDFDocument } from 'pdf-lib';
import './PDFProcessor.css';

const PDFProcessor: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [currentImageData, setCurrentImageData] = useState<string>('');
  const [processedImageData, setProcessedImageData] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setSelectedFile(file);
      setProcessedImageData('');
      setError('');
    } else {
      setError('Vui lòng chọn file PDF');
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file && file.type === 'application/pdf') {
      setSelectedFile(file);
      setProcessedImageData('');
      setError('');
    } else {
      setError('Vui lòng chọn file PDF');
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handlePDFToImage = (imageData: string) => {
    setCurrentImageData(imageData);
  };

  const handleRemoveRedMarkings = async () => {
    if (!currentImageData) {
      setError('Vui lòng đợi PDF được render');
      return;
    }

    setIsProcessing(true);
    setError('');

    try {
      const result = await removeRedMarkings(currentImageData);
      
      if (result.success && result.processedImageUrl) {
        setProcessedImageData(result.processedImageUrl);
      } else {
        setError(result.error || 'Lỗi khi xử lý PDF');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!processedImageData) return;

    try {
      // convert dataURL -> bytes
      const imageBytes = new Uint8Array(await (await fetch(processedImageData)).arrayBuffer());
      const pdfDoc = await PDFDocument.create();

      const embedded = await pdfDoc.embedPng(imageBytes);
      const { width, height } = embedded.size();
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(embedded, { x: 0, y: 0, width, height });

      const pdfBytes = await pdfDoc.save();
      const pdfBytesCopy = new Uint8Array(pdfBytes.byteLength);
      pdfBytesCopy.set(pdfBytes);
      const blob = new Blob([pdfBytesCopy.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `processed_${selectedFile?.name.replace(/\.pdf$/i, '') || 'document'}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Không thể tạo PDF để tải xuống';
      setError(message);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    setCurrentImageData('');
    setProcessedImageData('');
    setError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="pdf-processor-container">
      <h1>Xử lý PDF - Xóa đường viết màu đỏ</h1>

      {!selectedFile ? (
        <div
          className="upload-zone"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="upload-content">
            <div className="upload-icon">📄</div>
            <p>Kéo thả file PDF vào đây hoặc click để chọn file</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </div>
        </div>
      ) : (
        <div className="processing-area">
          <div className="file-info">
            <span>📄 {selectedFile.name}</span>
            <button onClick={handleReset} className="btn-secondary">
              Chọn file khác
            </button>
          </div>

          <div className="viewer-section">
            <div className="original-section">
              <h2>PDF gốc</h2>
              <PDFViewer file={selectedFile} onPDFToImage={handlePDFToImage} />
            </div>

            {processedImageData && (
              <div className="processed-section">
                <h2>Kết quả sau xử lý</h2>
                <div className="processed-image-container">
                  <img src={processedImageData} alt="Processed PDF" />
                </div>
              </div>
            )}
          </div>

          <div className="action-buttons">
            <button
              onClick={handleRemoveRedMarkings}
              disabled={isProcessing || !currentImageData}
              className="btn-primary"
            >
              {isProcessing ? '⏳ Đang xử lý...' : '🤖 Xóa đường viết màu đỏ'}
            </button>

            {processedImageData && (
              <button onClick={handleDownloadPdf} className="btn-success">
                ⬇️ Tải xuống (PDF)
              </button>
            )}
          </div>

          {error && <div className="error-message">❌ {error}</div>}
        </div>
      )}
    </div>
  );
};

export default PDFProcessor;
