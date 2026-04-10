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

export function bindDropzone(state: AppState, dom: DropzoneDom): void {
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
    if (files.length) void sendFiles(state, dom, files);
  });

  dom.fileInput.addEventListener('change', () => {
    const files = Array.from(dom.fileInput.files ?? []);
    if (files.length) void sendFiles(state, dom, files);
    dom.fileInput.value = '';
  });
}
