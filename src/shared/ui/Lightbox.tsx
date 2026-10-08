import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type LightboxProps = {
  /** Accessible name of the dialog. */
  label: string;
  closeLabel: string;
  onClose: () => void;
  /** Content shown over the backdrop; clicks that should not close it must stop propagation. */
  children: ReactNode;
};

/**
 * Fullscreen overlay in the claude.ai style: dark backdrop with a close button,
 * closing on backdrop click, the button, or Escape.
 *
 * Used by chat's ImageLightbox to expand an image and by code-editor's
 * MermaidDiagram to show a diagram in a zoomable viewer.
 */
export function Lightbox({ label, closeLabel, onClose, children }: LightboxProps) {
  useEffect(() => {
    // Capture phase, and stopped there, so an Escape that closes the overlay
    // does not also reach the editor or modal underneath.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      {children}
      {/* After the children so it stays above full-screen content such as a pan surface. */}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
    </div>,
    document.body,
  );
}
