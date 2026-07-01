import type { WebGLRenderer } from 'three';

export function capPixelRatio(value: number): number {
  return Math.min(Math.max(value, 1), 2);
}

export function bindWebGLLifecycle(
  canvas: HTMLCanvasElement,
  renderer: WebGLRenderer,
  onLost: () => void,
  onRestored: () => void,
): () => void {
  const lost = (event: Event) => {
    event.preventDefault();
    onLost();
  };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    renderer.dispose();
  };
}
