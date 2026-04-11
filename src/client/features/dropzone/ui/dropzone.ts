import type { AppState } from '../../../app/state.js';
import type { TransferDom } from '../../transfer/application/transfer.js';
import { sendFiles } from '../../transfer/application/transfer.js';

export interface DropzoneDom extends TransferDom {
  dropZone: HTMLElement;
  dropWaiting: HTMLElement;
  dropReady: HTMLElement;
  fileInput: HTMLInputElement;
}

export function enableDropZone(dom: DropzoneDom): void {
  dom.dropZone.classList.remove('disabled');
  dom.dropWaiting.style.display = 'none';
  dom.dropReady.style.display = 'grid';
}

export function disableDropZone(dom: DropzoneDom): void {
  dom.dropZone.classList.add('disabled');
  dom.dropWaiting.style.display = 'grid';
  dom.dropReady.style.display = 'none';
}

export function bindDropzone(state: AppState, dom: DropzoneDom, onError?: (msg: string) => void): void {
  function isConnected(): boolean {
    return state.dc?.readyState === 'open' || state.useRelay
  }

  dom.dropZone.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (dom.dropZone.classList.contains('disabled')) return;
    if (target.closest('.expiry-bar')) return;
    if (target === dom.fileInput || target.tagName === 'LABEL') return;
    dom.fileInput.click();
  });

  dom.dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    if (!dom.dropZone.classList.contains('disabled')) dom.dropZone.classList.add('drag-over');
  });

  dom.dropZone.addEventListener('dragleave', event => {
    if (!dom.dropZone.contains(event.relatedTarget as Node | null)) {
      dom.dropZone.classList.remove('drag-over');
    }
  });

  dom.dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    if (dom.dropZone.classList.contains('disabled')) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    if (!isConnected()) {
      onError?.('Sin conexión activa. Vuelve a conectarte.');
      return;
    }
    void sendFiles(state, dom, files, onError);
  });

  let pendingFilesHandled = false;

  function handleFileInputFiles() {
    if (pendingFilesHandled) return;
    const files = Array.from(dom.fileInput.files ?? []);
    if (!files.length) return;
    pendingFilesHandled = true;
    dom.fileInput.value = '';
    setTimeout(() => { pendingFilesHandled = false; }, 500);
    if (!isConnected()) {
      onError?.('La conexión se perdió al abrir el selector de archivos. Vuelve a conectarte.');
      return;
    }
    void sendFiles(state, dom, files, onError);
  }

  dom.fileInput.addEventListener('change', handleFileInputFiles);

  // Android Chrome no dispara 'change' al volver de la cámara; usamos visibilitychange como fallback
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      setTimeout(handleFileInputFiles, 400);
    }
  });
}
