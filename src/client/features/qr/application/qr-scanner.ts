interface BarcodeDetectorCtor {
  new(options?: { formats?: string[] }): BarcodeDetector;
}

interface BarcodeDetector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

export interface QrDom {
  inputCode: HTMLInputElement;
  qrScanner: HTMLDialogElement;
  qrVideo: HTMLVideoElement;
  scannerStatus: HTMLElement;
}

let scannerStream: MediaStream | null = null;
let scannerFrame: number | null = null;

export async function startQrScanner(
  dom: QrDom,
  showHomeError: (message: string) => void,
  joinRoom: () => void,
): Promise<void> {
  if (!window.isSecureContext) {
    showHomeError('La camara requiere HTTPS o localhost. Tambien puedes abrir el QR con la app Camara del movil.');
    return;
  }
  if (!window.BarcodeDetector) {
    showHomeError('Este navegador no permite leer QR desde la camara.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showHomeError('No se pudo acceder a la camara.');
    return;
  }

  try {
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    dom.qrVideo.srcObject = scannerStream;
    await dom.qrVideo.play();
    dom.scannerStatus.textContent = 'Apunta la camara al QR.';
    dom.qrScanner.showModal();

    const scan = async () => {
      if (!scannerStream) return;
      try {
        const codes = await detector.detect(dom.qrVideo);
        const room = extractRoomCode(codes[0]?.rawValue);
        if (room) {
          dom.inputCode.value = room;
          stopQrScanner(dom);
          joinRoom();
          return;
        }
        if (codes[0]?.rawValue) dom.scannerStatus.textContent = 'QR detectado, pero no parece una sala de fAir Drop.';
      } catch {
        dom.scannerStatus.textContent = 'Buscando QR...';
      }
      scannerFrame = requestAnimationFrame(scan);
    };

    scannerFrame = requestAnimationFrame(scan);
  } catch {
    stopQrScanner(dom);
    showHomeError('No se pudo abrir la camara.');
  }
}

export function stopQrScanner(dom: Pick<QrDom, 'qrScanner' | 'qrVideo'>): void {
  if (scannerFrame) cancelAnimationFrame(scannerFrame);
  scannerFrame = null;
  scannerStream?.getTracks().forEach(track => track.stop());
  scannerStream = null;
  dom.qrVideo.srcObject = null;
  if (dom.qrScanner.open) dom.qrScanner.close();
}

function extractRoomCode(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const room = url.searchParams.get('room');
    if (room && /^[A-Z0-9]{4}$/i.test(room)) return room.toUpperCase();
  } catch {
    // Plain room code fallback.
  }
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(trimmed) ? trimmed : null;
}
