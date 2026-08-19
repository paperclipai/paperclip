import { useState, useRef, useEffect, useCallback } from "react";
import { X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { validateAndNormalizeIsbn } from "@/lib/isbn";

interface DetectedBarcode {
  rawValue?: string;
  format?: string;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

interface BarcodeDetector {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (options?: BarcodeDetectorOptions) => BarcodeDetector;
  }
}

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (isbn: string) => void;
}

export function BarcodeScannerModal({ isOpen, onClose, onScan }: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setErrorMsg(null);
    } else {
      startCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, stopCamera]);

  async function startCamera() {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsScanning(true);
        runDetector();
      }
    } catch (err) {
      console.error("Camera access error:", err);
      setErrorMsg("Kamera-Berechtigung verweigert oder nicht verfügbar. Bitte nutzen Sie die manuelle Eingabe.");
      setIsScanning(false);
    }
  }

  function runDetector() {
    if (!isScanning && !streamRef.current) return;

    let detector: BarcodeDetector | null = null;
    if (window.BarcodeDetector) {
      try {
        detector = new window.BarcodeDetector({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
        });
      } catch (e) {
        console.warn("BarcodeDetector init failed", e);
      }
    }

    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (!detector) {
      stopCamera();
      setErrorMsg("Barcode-Erkennung wird von diesem Browser nicht unterstützt. Bitte nutzen Sie die manuelle Eingabe.");
      return;
    }

    const scanFrame = async () => {
      if (!streamRef.current || !videoEl) return;
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        if (detector) {
          try {
            const barcodes = await detector.detect(videoEl);
            for (const barcode of barcodes) {
              const val = barcode.rawValue;
              if (!val) continue;
              const normalized = validateAndNormalizeIsbn(val);
              if (normalized) {
                stopCamera();
                onScan(normalized);
                onClose();
                return;
              }
            }
          } catch (err) {
            // ignore detection frame errors
          }
        }
      }
      if (streamRef.current) {
        requestAnimationFrame(scanFrame);
      }
    };

    requestAnimationFrame(scanFrame);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="relative flex w-full max-w-md flex-col overflow-hidden rounded-lg bg-background shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold">ISBN Barcode scannen</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              stopCamera();
              onClose();
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative flex aspect-3/4 w-full items-center justify-center bg-black">
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
          {errorMsg ? (
            <div className="z-10 px-6 text-center text-sm text-destructive-foreground bg-destructive/80 py-3 rounded m-4">
              {errorMsg}
            </div>
          ) : (
            <div className="absolute inset-0 border-2 border-dashed border-primary/50 m-12 pointer-events-none flex items-center justify-center">
              <span className="bg-black/60 text-white text-xs px-2 py-1 rounded">Barcode hier positionieren</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">Unterstützt EAN-13 / ISBN</span>
          {errorMsg ? (
            <Button size="sm" variant="outline" onClick={startCamera}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Erneut versuchen
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { stopCamera(); onClose(); }}>
              Abbrechen
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
